import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
    private dataSource: DataSource,
    private readonly s3Service: S3Service,
    private readonly sqsService: SqsService,
    private readonly eventEmitter: EventEmitter2,
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

    this.eventEmitter.emit('purchase.created', {
      type: 'created',
      msg: 'New purchase created',
      raffleId: createdPurchase.raffleId,
      purchaseId: createdPurchase.uid,
    });

    return createdPurchase;
  }

  private async assignTickets(
    manager: EntityManager,
    purchase: Purchase,
  ): Promise<void> {
    // Lock the raffle row to prevent concurrent allocations (over-selling).
    const raffle = await manager.findOne(Raffle, {
      where: { uid: purchase.raffleId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!raffle) throw new NotFoundException('Raffle not found');

    // Get already sold tickets for this raffle (optimized query on the array column).
    const soldTicketsRaw = await manager.query(
      `SELECT unnest("ticket_numbers") as num
       FROM purchase
       WHERE "raffle_id" = $1
         AND "ticket_numbers" IS NOT NULL
         AND uid != $2`,
      [raffle.uid, purchase.uid],
    );

    const soldSet = new Set<number>(
      soldTicketsRaw.map((s: { num: number }) => Number(s.num)),
    );

    const available = raffle.totalTickets - soldSet.size;
    if (available < purchase.ticketQuantity) {
      throw new ConflictException('Not enough tickets available.');
    }

    // Smart random generation (0..totalTickets-1), avoiding collisions with sold + in-flight.
    const toAssign: number[] = [];
    const maxAttempts = purchase.ticketQuantity * 10;
    let attempts = 0;

    while (toAssign.length < purchase.ticketQuantity && attempts < maxAttempts) {
      const randomNum = Math.floor(Math.random() * raffle.totalTickets);
      if (!soldSet.has(randomNum)) {
        toAssign.push(randomNum);
        soldSet.add(randomNum);
      }
      attempts++;
    }

    if (toAssign.length < purchase.ticketQuantity) {
      throw new ConflictException('Could not assign tickets, please try again.');
    }

    purchase.ticketNumbers = toAssign;
    await manager.save(Purchase, purchase);

    this.eventEmitter.emit('purchase.status_changed', {
      type: 'verified',
      msg: 'Purchase verified',
      raffleId: purchase.raffleId,
      purchaseId: purchase.uid,
      status: PurchaseStatus.VERIFIED,
    });
  }

  async updateStatus(uid: string, updateDto: UpdatePurchaseStatusDto) {
    const { status } = updateDto;

    return this.dataSource.transaction(async (manager) => {
      const purchase = await manager.findOne(Purchase, {
        where: { uid },
      });

      if (!purchase) throw new NotFoundException('Purchase not found');
      const wasVerified = purchase.status === PurchaseStatus.VERIFIED;
      if (wasVerified) throw new BadRequestException('Purchase has already been verified.');

      purchase.status = status;
      if (status === PurchaseStatus.VERIFIED) {
        purchase.verifiedAt = new Date();
      }

      if (status === PurchaseStatus.VERIFIED && !wasVerified) {
        await this.assignTickets(manager, purchase);
      } else {
        await manager.save(Purchase, purchase);
        // Emit status change for non-verified statuses (rejected, manual_review, etc.)
        this.eventEmitter.emit('purchase.status_changed', {
          type: 'status_changed',
          msg: `Purchase status changed to ${status}`,
          raffleId: purchase.raffleId,
          purchaseId: purchase.uid,
          status,
        });
      }

      return {
        ...purchase,
        tickets: purchase.ticketNumbers ?? [],
      };
    });
  }

  async findAll(query: Record<string, unknown>) {
    const raffleId =
      typeof query.raffleId === 'string' ? query.raffleId : undefined;
    const status = typeof query.status === 'string' ? query.status : undefined;
    const nationalId =
      typeof query.nationalId === 'string' ? query.nationalId : undefined;
    const currency =
      typeof query.currency === 'string' ? query.currency : undefined;
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
      .leftJoinAndSelect('paymentMethod.currency', 'currency')
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
    if (currency) {
      qb.andWhere('currency.symbol = :currency', { currency });
    }
    if (ticketNumber !== undefined && !Number.isNaN(ticketNumber)) {
      qb.andWhere(':ticketNumber = ANY(purchase.ticketNumbers)', { ticketNumber });
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

        const { currency, ...paymentMethodRest } = purchase.paymentMethod || {};
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
                ...paymentMethodRest,
                currency: currency?.symbol || null,
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
      relations: ['customer', 'raffle', 'paymentMethod', 'paymentMethod.currency'],
    });
    if (!purchase) throw new NotFoundException('Purchase not found');

    const [paymentScreenshotUrl, raffleImageUrl, paymentMethodImageUrl] =
      await Promise.all([
        this.s3Service.getPresignedGetUrl(purchase.paymentScreenshotUrl),
        this.s3Service.getPresignedGetUrl(purchase.raffle?.imageUrl),
        this.s3Service.getPresignedGetUrl(purchase.paymentMethod?.imageUrl),
      ]);

    const { currency, ...paymentMethodRest } = purchase.paymentMethod || {};
    return {
      ...purchase,
      ticketNumbers: purchase.ticketNumbers || [], // Ensure it returns array
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
            ...paymentMethodRest,
            currency: currency?.symbol || null,
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
    const { purchaseId, aiResult } = webhook;

    return this.dataSource.transaction(async (manager) => {
      const purchase = await manager.findOne(Purchase, {
        where: { uid: purchaseId },
        relations: ['raffle', 'paymentMethod', 'paymentMethod.currency'],
      });
      if (!purchase) throw new NotFoundException('Purchase not found');

      const wasVerified = purchase.status === PurchaseStatus.VERIFIED;

      purchase.aiAnalysisResult = aiResult ?? null;

      // Define structure for type safety
      interface ReceiptData {
        amount: number | null;
        currency: string | null;
        reference: string | null;
      }

      const aiData = aiResult as ReceiptData;

      // Helper function to serialize purchase with currency as symbol
      const serializePurchase = (p: Purchase) => {
        const { currency, ...paymentMethodRest } = p.paymentMethod || {};
        return {
          ...p,
          paymentMethod: p.paymentMethod
            ? {
                ...paymentMethodRest,
                currency: currency?.symbol || null,
              }
            : p.paymentMethod,
        };
      };

      // 1. Check if AI data is sufficient
      if (!aiData?.amount || !aiData?.currency || !aiData?.reference) {
        purchase.status = PurchaseStatus.MANUAL_REVIEW;
        const savedPurchase = await manager.save(Purchase, purchase);
        this.eventEmitter.emit('purchase.status_changed', {
          type: 'manual_review',
          msg: 'Purchase requires manual review (insufficient AI data)',
          raffleId: purchase.raffleId,
          purchaseId: purchase.uid,
          status: PurchaseStatus.MANUAL_REVIEW,
        });
        return serializePurchase(savedPurchase);
      }

      // 2. Check for duplicates by reference
      const cleanAiRef = String(aiData.reference).replace(/\D/g, '');

      // Use REGEXP_REPLACE to compare only digits from the database column
      // This ensures that "123-456" in DB matches "123456" from AI
      const existingWithRef = await manager
        .getRepository(Purchase)
        .createQueryBuilder('p')
        .where('p.uid != :uid', { uid: purchaseId })
        .andWhere("REGEXP_REPLACE(p.bank_reference, '\\D', '', 'g') LIKE :ref", {
          ref: `%${cleanAiRef}%`,
        })
        .getOne();

      if (existingWithRef) {
        purchase.status = PurchaseStatus.DUPLICATED;
        const savedPurchase = await manager.save(Purchase, purchase);
        this.eventEmitter.emit('purchase.status_changed', {
          type: 'duplicated',
          msg: 'Purchase marked as duplicated',
          raffleId: purchase.raffleId,
          purchaseId: purchase.uid,
          status: PurchaseStatus.DUPLICATED,
        });
        return serializePurchase(savedPurchase);
      }

      // 3. Verify amount
      const amountDiff = Math.abs(purchase.totalAmount - aiData.amount);
      const isAmountValid = amountDiff < 0.01;

      // 4. Verify currency
      const expectedCurrency = purchase.paymentMethod?.currency;
      const isCurrencyValid = expectedCurrency?.symbol === aiData.currency;

      // 5. Verify reference (fuzzy match)
      const cleanUserRef = purchase.bankReference.replace(/\D/g, '');
      const isRefValid =
        cleanAiRef.endsWith(cleanUserRef) || cleanUserRef.endsWith(cleanAiRef);

      if (isAmountValid && isCurrencyValid && isRefValid) {
        purchase.status = PurchaseStatus.VERIFIED;
        purchase.verifiedAt = new Date();
      } else {
        purchase.status = PurchaseStatus.MANUAL_REVIEW;
      }

      if (purchase.status === PurchaseStatus.VERIFIED && !wasVerified) {
        await this.assignTickets(manager, purchase);
        return serializePurchase(purchase);
      }

      const updatedPurchase = await manager.save(Purchase, purchase);
      // Emit for manual review from AI validation
      if (purchase.status === PurchaseStatus.MANUAL_REVIEW) {
        this.eventEmitter.emit('purchase.status_changed', {
          type: 'manual_review',
          msg: 'Purchase requires manual review (AI validation failed)',
          raffleId: purchase.raffleId,
          purchaseId: purchase.uid,
          status: PurchaseStatus.MANUAL_REVIEW,
        });
      }
      return serializePurchase(updatedPurchase);
    });
  }


  async migrateTickets() {
    const BATCH_SIZE = 100;
    let processed = 0;

    // Find verified purchases with no ticketNumbers array
    const purchases = await this.purchaseRepository.find({
      where: {
        status: PurchaseStatus.VERIFIED,
        ticketNumbers: null,
      },
      take: BATCH_SIZE,
    });

    if (purchases.length === 0) {
      return { message: 'No purchases to migrate' };
    }

    for (const purchase of purchases) {
      const tickets = await this.ticketRepository.find({
        where: { purchaseId: purchase.uid },
        select: { ticketNumber: true },
      });

      if (tickets.length > 0) {
        purchase.ticketNumbers = tickets.map((t) => t.ticketNumber);
        await this.purchaseRepository.save(purchase);
        processed++;
      }
    }

    return {
      message: `Migrated ${processed} purchases`,
      remaining: purchases.length === BATCH_SIZE,
    };
  }
}
