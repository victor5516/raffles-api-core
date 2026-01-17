import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Purchase, PurchaseStatus } from './entities/purchase.entity';
import { Ticket } from 'src/modules/tickets/entities/ticket.entity';
import { Customer } from 'src/modules/customers/entities/customer.entity';
import { Raffle } from 'src/modules/raffles/entities/raffle.entity';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { UpdatePurchaseStatusDto } from './dto/update-purchase-status.dto';
import { S3Service } from '../../common/s3/s3.service';
import { SqsService } from '../../common/sqs/sqs.service';
import { AiWebhookDto } from './dto/ai-webhook.dto';

@Injectable()
export class PurchasesService {
  private readonly logger = new Logger(PurchasesService.name);

  constructor(
    @InjectRepository(Purchase)
    private purchaseRepository: Repository<Purchase>,
    @InjectRepository(Ticket)
    private ticketRepository: Repository<Ticket>,
    @InjectRepository(Customer)
    private customerRepository: Repository<Customer>,
    @InjectRepository(Raffle)
    private raffleRepository: Repository<Raffle>,
    private dataSource: DataSource,
    private readonly s3Service: S3Service,
    private readonly sqsService: SqsService,
  ) {}

  async create(
    createDto: CreatePurchaseDto,
    file: Express.Multer.File | undefined,
  ) {
    const createdPurchase = await this.dataSource.transaction(async (manager) => {
      // 1. Handle Customer
      const { customer: customerData, ...purchaseData } = createDto;

      let customerEntity: Customer;

      const existingCustomer = await manager.findOne(Customer, {
        where: { nationalId: customerData.national_id },
      });

      if (existingCustomer) {
        existingCustomer.fullName = customerData.full_name;
        existingCustomer.email = customerData.email;
        existingCustomer.phone = customerData.phone || existingCustomer.phone;
        customerEntity = await manager.save(Customer, existingCustomer);
      } else {
        const newCustomer = manager.create(Customer, {
          nationalId: customerData.national_id,
          fullName: customerData.full_name,
          email: customerData.email,
          phone: customerData.phone,
        });
        customerEntity = await manager.save(Customer, newCustomer);
      }

      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');

      const { key } = await this.s3Service.uploadBuffer({
        keyPrefix: `purchases/${purchaseData.raffleId}/${year}/${month}`,
        originalName: file.originalname,
        buffer: file.buffer,
        contentType: file.mimetype,
      });

      // 2. Create Purchase
      const purchase = manager.create(Purchase, {
        raffleId: purchaseData.raffleId,
        paymentMethodId: purchaseData.paymentMethodId,
        ticketQuantity: purchaseData.ticket_quantity,
        paymentScreenshotUrl: key,
        bankReference: purchaseData.bank_reference,
        customerId: customerEntity.uid,
        totalAmount: purchaseData.totalAmount,
      });

      return await manager.save(Purchase, purchase);
    });

    try {
      await this.sqsService.sendPurchaseCreatedMessage(createdPurchase);
    } catch (err) {
      this.logger.error(
        'Failed to send purchase created message to SQS.',
        err instanceof Error ? err.stack : String(err),
      );
    }

    return createdPurchase;
  }

  async updateStatus(uid: string, updateDto: UpdatePurchaseStatusDto) {
    const { status } = updateDto;

    return this.dataSource.transaction(async (manager) => {
      const purchase = await manager.findOne(Purchase, {
        where: { uid },
        relations: ['raffle'],
      });

      if (!purchase) throw new NotFoundException('Purchase not found');

      if (purchase.status === PurchaseStatus.VERIFIED) {
        throw new BadRequestException('Purchase has already been verified.');
      }

      purchase.status = status;
      if (status === PurchaseStatus.VERIFIED) {
        purchase.verifiedAt = new Date();
      }

      const updatedPurchase = await manager.save(Purchase, purchase);
      let assignedTickets: number[] = [];

      if (status === PurchaseStatus.VERIFIED) {
        const { ticketQuantity, raffle } = purchase;

        // Ticket Logic
        // Fix: Use generic FindOptions type or explicit casting if strict checks fail
        // or ensure Ticket entity is correctly imported.
        // Assuming Ticket has ticketNumber column.
        const soldTickets = await manager.find(Ticket, {
          where: { raffleId: raffle.uid },
          select: { ticketNumber: true },
        });
        const soldTicketNumbers = new Set(
          soldTickets.map((t) => t.ticketNumber),
        );

        const totalTickets = raffle.totalTickets;
        const allPossibleNumbers = Array.from(
          { length: totalTickets },
          (_, i) => i,
        );

        // Fisher-Yates Shuffle
        for (let i = allPossibleNumbers.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [allPossibleNumbers[i], allPossibleNumbers[j]] = [
            allPossibleNumbers[j],
            allPossibleNumbers[i],
          ];
        }

        const toAssign: number[] = [];
        for (const num of allPossibleNumbers) {
          if (toAssign.length >= ticketQuantity) break;
          if (!soldTicketNumbers.has(num)) {
            toAssign.push(num);
          }
        }

        if (toAssign.length < ticketQuantity) {
          throw new ConflictException('Not enough tickets available.');
        }

        // Create tickets
        const tickets = toAssign.map((num) =>
          manager.create(Ticket, {
            raffleId: raffle.uid,
            purchaseId: purchase.uid,
            ticketNumber: num,
          }),
        );

        await manager.save(Ticket, tickets);
        assignedTickets = toAssign;
      }

      return {
        ...updatedPurchase,
        tickets: assignedTickets,
      };
    });
  }

  async findAll(query: Record<string, unknown>) {
    const raffleId =
      typeof query.raffleId === 'string' ? query.raffleId : undefined;
    const status = typeof query.status === 'string' ? query.status : undefined;
    const nationalId =
      typeof query.nationalId === 'string' ? query.nationalId : undefined;
    const ticketNumberRaw = query.ticketNumber;
    const ticketNumber =
      typeof ticketNumberRaw === 'string' || typeof ticketNumberRaw === 'number'
        ? Number(ticketNumberRaw)
        : undefined;

    const pageRaw = query.page;
    const limitRaw = query.limit;
    const page =
      typeof pageRaw === 'string' || typeof pageRaw === 'number'
        ? Math.max(1, Number(pageRaw))
        : 1;
    const limit =
      typeof limitRaw === 'string' || typeof limitRaw === 'number'
        ? Math.max(1, Number(limitRaw))
        : 20;

    const skip = (page - 1) * limit;

    const qb = this.purchaseRepository
      .createQueryBuilder('purchase')
      .leftJoinAndSelect('purchase.customer', 'customer')
      .leftJoinAndSelect('purchase.raffle', 'raffle')
      .leftJoinAndSelect('purchase.paymentMethod', 'paymentMethod')
      .orderBy('purchase.submittedAt', 'DESC')
      .skip(skip)
      .take(limit);

    if (raffleId) {
      qb.andWhere('purchase.raffleId = :raffleId', { raffleId });
    }
    if (status) {
      qb.andWhere('purchase.status = :status', { status });
    }
    if (nationalId) {
      qb.andWhere('customer.nationalId LIKE :nationalId', {
        nationalId: `%${nationalId}%`,
      });
    }
    if (ticketNumber !== undefined && !Number.isNaN(ticketNumber)) {
      qb.innerJoin(
        'purchase.tickets',
        'ticket',
        'ticket.ticketNumber = :ticketNumber',
        { ticketNumber },
      );
    }

    const [items, total] = await qb.getManyAndCount();

    const signedItems = await Promise.all(
      items.map(async (purchase) => {
        const [paymentScreenshotUrl, raffleImageUrl, paymentMethodImageUrl] =
          await Promise.all([
            this.s3Service.getPresignedGetUrl(purchase.paymentScreenshotUrl),
            this.s3Service.getPresignedGetUrl(purchase.raffle?.imageUrl),
            this.s3Service.getPresignedGetUrl(purchase.paymentMethod?.imageUrl),
          ]);

        return {
          ...purchase,
          paymentScreenshotUrl:
            paymentScreenshotUrl ?? purchase.paymentScreenshotUrl,
          raffle: purchase.raffle
            ? {
                ...purchase.raffle,
                imageUrl: raffleImageUrl ?? purchase.raffle.imageUrl,
              }
            : purchase.raffle,
          paymentMethod: purchase.paymentMethod
            ? {
                ...purchase.paymentMethod,
                imageUrl:
                  paymentMethodImageUrl ?? purchase.paymentMethod.imageUrl,
              }
            : purchase.paymentMethod,
        };
      }),
    );

    return {
      items: signedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(uid: string) {
    const purchase = await this.purchaseRepository.findOne({
      where: { uid },
      relations: ['customer', 'raffle', 'paymentMethod', 'tickets'],
    });
    if (!purchase) throw new NotFoundException('Purchase not found');

    const [paymentScreenshotUrl, raffleImageUrl, paymentMethodImageUrl] =
      await Promise.all([
        this.s3Service.getPresignedGetUrl(purchase.paymentScreenshotUrl),
        this.s3Service.getPresignedGetUrl(purchase.raffle?.imageUrl),
        this.s3Service.getPresignedGetUrl(purchase.paymentMethod?.imageUrl),
      ]);

    return {
      ...purchase,
      paymentScreenshotUrl:
        paymentScreenshotUrl ?? purchase.paymentScreenshotUrl,
      raffle: purchase.raffle
        ? {
            ...purchase.raffle,
            imageUrl: raffleImageUrl ?? purchase.raffle.imageUrl,
          }
        : purchase.raffle,
      paymentMethod: purchase.paymentMethod
        ? {
            ...purchase.paymentMethod,
            imageUrl: paymentMethodImageUrl ?? purchase.paymentMethod.imageUrl,
          }
        : purchase.paymentMethod,
    };
  }

  async remove(uid: string) {
    const result = await this.purchaseRepository.delete(uid);
    if (result.affected === 0)
      throw new NotFoundException('Purchase not found');
  }

  async processAiWebhook(webhook: AiWebhookDto) {
    const { purchaseId, status, aiResult } = webhook;
    const purchase = await this.purchaseRepository.findOne({
      where: { uid: purchaseId },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    purchase.status = status;
    purchase.aiAnalysisResult = aiResult;
    return await this.purchaseRepository.save(purchase);
  }
}
