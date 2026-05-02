import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Raffle } from './entities/raffle.entity';
import {
  Purchase,
  PurchaseStatus,
} from '../purchases/entities/purchase.entity';
import { CreateRaffleDto } from './dto/create-raffle.dto';
import { UpdateRaffleDto } from './dto/update-raffle.dto';
import { S3Service } from '../../common/s3/s3.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { AuditEventPayload } from '../audit-logs/dto/audit-event.payload';

@Injectable()
export class RafflesService {
  constructor(
    @InjectRepository(Raffle)
    private raffleRepository: Repository<Raffle>,
    @InjectRepository(Purchase)
    private purchaseRepository: Repository<Purchase>,
    private readonly s3Service: S3Service,
    private readonly currenciesService: CurrenciesService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createWithImage(
    createRaffleDto: CreateRaffleDto,
    file: Express.Multer.File | undefined,
    galleryFiles: Express.Multer.File[] = [],
  ) {
    if (file) {
      const { key } = await this.s3Service.uploadBuffer({
        keyPrefix: `raffles`,
        originalName: file.originalname,
        buffer: file.buffer,
        contentType: file.mimetype,
      });
      createRaffleDto = { ...createRaffleDto, image_url: key };
    }
    if (galleryFiles.length > 0) {
      const results = await Promise.all(
        galleryFiles.map((f) =>
          this.s3Service.uploadBuffer({
            keyPrefix: `raffles`,
            originalName: f.originalname,
            buffer: f.buffer,
            contentType: f.mimetype,
          }),
        ),
      );
      const galleryUrls = results.map((r) => r.key);
      createRaffleDto = { ...createRaffleDto, gallery: galleryUrls };
    }
    return this.create(createRaffleDto);
  }

  async updateWithImage(
    uid: string,
    updateRaffleDto: UpdateRaffleDto,
    file: Express.Multer.File | undefined,
    userId?: string,
    galleryFiles: Express.Multer.File[] = [],
    adminId?: string,
  ) {
    if (file) {
      if (!userId) throw new UnauthorizedException();
      const { key } = await this.s3Service.uploadBuffer({
        keyPrefix: `raffles/${userId}`,
        originalName: file.originalname,
        buffer: file.buffer,
        contentType: file.mimetype,
      });
      updateRaffleDto = { ...updateRaffleDto, image_url: key };
    }

    let galleryKeysToDelete: string[] = [];
    if (updateRaffleDto.gallery_keys_to_delete) {
      try {
        const parsed = JSON.parse(updateRaffleDto.gallery_keys_to_delete);
        galleryKeysToDelete = Array.isArray(parsed)
          ? parsed.filter((k): k is string => typeof k === 'string')
          : [];
      } catch {
        galleryKeysToDelete = [];
      }
    }

    const hasGalleryChanges =
      galleryKeysToDelete.length > 0 || galleryFiles.length > 0;
    if (hasGalleryChanges) {
      if (galleryKeysToDelete.length > 0) {
        await Promise.all(
          galleryKeysToDelete.map((key) =>
            this.s3Service.deleteObject(key).catch(() => {}),
          ),
        );
      }

      const existing = await this.raffleRepository.findOne({
        where: { uid },
        select: ['gallery'],
      });
      const existingGallery = existing?.gallery ?? [];
      const remaining = existingGallery.filter(
        (k) => !galleryKeysToDelete.includes(k),
      );

      if (galleryFiles.length > 0) {
        const results = await Promise.all(
          galleryFiles.map((f) =>
            this.s3Service.uploadBuffer({
              keyPrefix: userId ? `raffles/${userId}` : 'raffles',
              originalName: f.originalname,
              buffer: f.buffer,
              contentType: f.mimetype,
            }),
          ),
        );
        const newKeys = results.map((r) => r.key);
        updateRaffleDto = {
          ...updateRaffleDto,
          gallery: [...remaining, ...newKeys],
        };
      } else {
        updateRaffleDto = { ...updateRaffleDto, gallery: remaining };
      }
    }

    const { gallery_keys_to_delete: _removed, ...dtoForUpdate } =
      updateRaffleDto;
    return this.update(uid, dtoForUpdate, adminId);
  }

  async create(createRaffleDto: CreateRaffleDto) {
    const raffle = this.raffleRepository.create({
      ...createRaffleDto,
      deadline: new Date(createRaffleDto.deadline),
      digitsLength: createRaffleDto.digits_length,
      ticketPrice: createRaffleDto.ticket_price,
      totalTickets: createRaffleDto.total_tickets,
      minTicketsPerPurchase: createRaffleDto.min_tickets_per_purchase,
      imageUrl: createRaffleDto.image_url,
      gallery: createRaffleDto.gallery ?? [],
      selectionType: createRaffleDto.selection_type,
      promotionStrategy: createRaffleDto.promotion_strategy ?? null,
      promotionConfig: createRaffleDto.promotion_config ?? null,
      termsAndConditions: createRaffleDto.terms_and_conditions ?? null,
      showProgressBar: createRaffleDto.show_progress_bar ?? false,
      showTopBuyers: createRaffleDto.show_top_buyers ?? false,
      spreadsheetId: createRaffleDto.spreadsheet_id,
    });
    const savedRaffle = await this.raffleRepository.save(raffle);
    const currencies = await this.currenciesService.findAll();
    return {
      ...savedRaffle,
      prices: this.calculatePrices(savedRaffle.ticketPrice, currencies),
    };
  }

  async findAllEfficient() {
    // 1. Obtener datos crudos (raffles, monedas, y suma de tickets por raffle)
    const qb = this.raffleRepository
      .createQueryBuilder('raffle')
      .orderBy('raffle.created_at', 'DESC');

    const soldByRaffleQb = this.purchaseRepository
      .createQueryBuilder('purchase')
      .select('purchase.raffleId', 'raffleId')
      .addSelect('COALESCE(SUM(purchase.ticketQuantity), 0)', 'ticketsSold')
      .where('purchase.status NOT IN (:rejected, :duplicated)', {
        rejected: PurchaseStatus.REJECTED,
        duplicated: PurchaseStatus.DUPLICATED,
      })
      .groupBy('purchase.raffleId');

    const [raffles, currencies, soldByRaffleRaw] = await Promise.all([
      qb.getMany(),
      this.currenciesService.findAll(),
      soldByRaffleQb.getRawMany<{
        raffleId: string;
        ticketsSold: string | number;
      }>(),
    ]);

    const soldByRaffle = new Map<string, number>(
      soldByRaffleRaw.map((r) => [r.raffleId, Number(r.ticketsSold ?? 0)]),
    );

    for (const raffle of raffles) {
      (raffle as Raffle & { ticketsSold: number }).ticketsSold =
        soldByRaffle.get(raffle.uid) ?? 0;
    }

    // 2. Procesar en paralelo usando una función helper
    return Promise.all(
      raffles.map((raffle) => this.transformRaffle(raffle, currencies)),
    );
  }

  private calculatePrices(basePrice: number, currencies: any[]) {
    const prices: Record<string, number> = {};

    // Base currency (USD)
    prices['USD'] = Number(basePrice);

    // Other currencies
    currencies.forEach((currency) => {
      if (currency.symbol !== 'USD') {
        prices[currency.symbol] = Number(basePrice) * Number(currency.value);
      }
    });

    return prices;
  }

  async findOne(uid: string) {
    const raffle = await this.raffleRepository.findOne({ where: { uid } });
    if (!raffle) throw new NotFoundException('Raffle not found');

    const currencies = await this.currenciesService.findAll();

    const galleryUrls =
      raffle.gallery?.length > 0
        ? (
            await Promise.all(
              raffle.gallery.map((key) =>
                this.s3Service.getPresignedGetUrl(key),
              ),
            )
          ).filter((url): url is string => url != null)
        : [];

    const imageUrl =
      (await this.s3Service.getPresignedGetUrl(raffle.imageUrl)) ??
      raffle.imageUrl;

    return {
      ...raffle,
      imageUrl,
      gallery: galleryUrls,
      galleryKeys: raffle.gallery ?? [],
      prices: this.calculatePrices(raffle.ticketPrice, currencies),
    };
  }

  async update(
    uid: string,
    updateRaffleDto: UpdateRaffleDto,
    adminId?: string,
  ) {
    const oldData = await this.findOne(uid);

    const updateData: Partial<Raffle> = {};
    if (updateRaffleDto.title) updateData.title = updateRaffleDto.title;
    if (updateRaffleDto.description)
      updateData.description = updateRaffleDto.description;
    if (updateRaffleDto.deadline)
      updateData.deadline = new Date(updateRaffleDto.deadline);
    if (updateRaffleDto.digits_length)
      updateData.digitsLength = updateRaffleDto.digits_length;
    if (updateRaffleDto.ticket_price)
      updateData.ticketPrice = updateRaffleDto.ticket_price;
    if (updateRaffleDto.total_tickets)
      updateData.totalTickets = updateRaffleDto.total_tickets;
    if (updateRaffleDto.min_tickets_per_purchase !== undefined)
      updateData.minTicketsPerPurchase =
        updateRaffleDto.min_tickets_per_purchase;
    if (updateRaffleDto.image_url)
      updateData.imageUrl = updateRaffleDto.image_url;
    if (updateRaffleDto.gallery !== undefined)
      updateData.gallery = updateRaffleDto.gallery;
    if (updateRaffleDto.status) updateData.status = updateRaffleDto.status;
    if (updateRaffleDto.selection_type !== undefined)
      updateData.selectionType = updateRaffleDto.selection_type;
    if (updateRaffleDto.promotion_strategy !== undefined)
      updateData.promotionStrategy = updateRaffleDto.promotion_strategy;
    if (updateRaffleDto.promotion_config !== undefined)
      updateData.promotionConfig = updateRaffleDto.promotion_config;
    if (updateRaffleDto.terms_and_conditions !== undefined)
      updateData.termsAndConditions = updateRaffleDto.terms_and_conditions;
    if (updateRaffleDto.show_progress_bar !== undefined)
      updateData.showProgressBar = updateRaffleDto.show_progress_bar;
    if (updateRaffleDto.show_top_buyers !== undefined)
      updateData.showTopBuyers = updateRaffleDto.show_top_buyers;
    if (updateRaffleDto.spreadsheet_id !== undefined)
      updateData.spreadsheetId = updateRaffleDto.spreadsheet_id;

    await this.raffleRepository.update(uid, updateData);
    const newData = await this.findOne(uid);

    this.eventEmitter.emit('audit.log', {
      adminId: adminId ?? null,
      action: 'UPDATE',
      entityName: 'Raffle',
      entityId: uid,
      previousData: oldData,
      newData,
    } satisfies AuditEventPayload);

    return newData;
  }

  async remove(uid: string, adminId: string) {
    const oldData = await this.findOne(uid);
    const result = await this.raffleRepository.delete(uid);
    if (result.affected === 0) throw new NotFoundException('Raffle not found');

    this.eventEmitter.emit('audit.log', {
      adminId,
      action: 'DELETE',
      entityName: 'Raffle',
      entityId: uid,
      previousData: oldData,
      newData: null,
    } satisfies AuditEventPayload);
  }

  private async transformRaffle(raffle: any, currencies: any[]) {
    const ticketsSold = raffle.ticketsSold || 0;

    const imageUrl = raffle.imageUrl
      ? await this.s3Service.getPresignedGetUrl(raffle.imageUrl)
      : null;
    const gallery =
      raffle.gallery?.length > 0
        ? await Promise.all(
            raffle.gallery.map((key: string) =>
              this.s3Service.getPresignedGetUrl(key),
            ),
          )
        : [];

    return {
      ...raffle,
      imageUrl,
      gallery: gallery.filter((url): url is string => url != null),
      tickets_sold: ticketsSold,
      percentage_sold:
        raffle.totalTickets > 0 ? (ticketsSold / raffle.totalTickets) * 100 : 0,
      prices: this.calculatePrices(raffle.ticketPrice, currencies),
    };
  }
}
