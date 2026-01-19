import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Raffle } from './entities/raffle.entity';
import { CreateRaffleDto } from './dto/create-raffle.dto';
import { UpdateRaffleDto } from './dto/update-raffle.dto';
import { S3Service } from '../../common/s3/s3.service';
import { CurrenciesService } from '../currencies/currencies.service';

@Injectable()
export class RafflesService {
  constructor(
    @InjectRepository(Raffle)
    private raffleRepository: Repository<Raffle>,
    private readonly s3Service: S3Service,
    private readonly currenciesService: CurrenciesService,
  ) {}

  async createWithImage(
    createRaffleDto: CreateRaffleDto,
    file: Express.Multer.File | undefined,
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
    return this.create(createRaffleDto);
  }

  async updateWithImage(
    uid: string,
    updateRaffleDto: UpdateRaffleDto,
    file: Express.Multer.File | undefined,
    userId?: string,
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
    return this.update(uid, updateRaffleDto);
  }

  async create(createRaffleDto: CreateRaffleDto) {
    const raffle = this.raffleRepository.create({
      ...createRaffleDto,
      deadline: new Date(createRaffleDto.deadline),
      digitsLength: createRaffleDto.digits_length,
      ticketPrice: createRaffleDto.ticket_price,
      totalTickets: createRaffleDto.total_tickets,
      imageUrl: createRaffleDto.image_url,
    });
    const savedRaffle = await this.raffleRepository.save(raffle);
    const currencies = await this.currenciesService.findAll();
    return {
      ...savedRaffle,
      prices: this.calculatePrices(savedRaffle.ticketPrice, currencies),
    };
  }

  async findAllEfficient() {
    const qb = this.raffleRepository
      .createQueryBuilder('raffle')
      .loadRelationCountAndMap('raffle.ticketsSold', 'raffle.tickets')
      .orderBy('raffle.created_at', 'DESC');

    const [raffles, currencies] = await Promise.all([
      qb.getMany(),
      this.currenciesService.findAll(),
    ]);

    return await Promise.all(
      raffles.map(async (r) => {
        const ticketsSold = (r as unknown as { ticketsSold: number })
          .ticketsSold;
        return {
          ...r,
          imageUrl:
            (await this.s3Service.getPresignedGetUrl(r.imageUrl)) ?? r.imageUrl,
          tickets_sold: ticketsSold,
          percentage_sold:
            r.totalTickets > 0 ? (ticketsSold / r.totalTickets) * 100 : 0,
          prices: this.calculatePrices(r.ticketPrice, currencies),
        };
      }),
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

    return {
      ...raffle,
      imageUrl:
        (await this.s3Service.getPresignedGetUrl(raffle.imageUrl)) ??
        raffle.imageUrl,
      prices: this.calculatePrices(raffle.ticketPrice, currencies),
    };
  }

  async update(uid: string, updateRaffleDto: UpdateRaffleDto) {
    await this.findOne(uid);

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
    if (updateRaffleDto.image_url)
      updateData.imageUrl = updateRaffleDto.image_url;
    if (updateRaffleDto.status) updateData.status = updateRaffleDto.status;

    await this.raffleRepository.update(uid, updateData);
    return this.findOne(uid);
  }

  async remove(uid: string) {
    const result = await this.raffleRepository.delete(uid);
    if (result.affected === 0) throw new NotFoundException('Raffle not found');
  }
}
