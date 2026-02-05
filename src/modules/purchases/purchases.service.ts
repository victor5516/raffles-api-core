import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository, ILike } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as ExcelJS from 'exceljs';
import { Purchase, PurchaseStatus } from './entities/purchase.entity';
import { Ticket } from 'src/modules/tickets/entities/ticket.entity';
import { Customer } from 'src/modules/customers/entities/customer.entity';
import {
  Raffle,
  RaffleSelectionType,
  RaffleStatus,
} from 'src/modules/raffles/entities/raffle.entity';
import { PaymentMethod } from 'src/modules/payments/entities/payment-method.entity';
import { Currency } from 'src/modules/currencies/entities/currency.entity';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { UpdatePurchaseDto } from './dto/update-purchase.dto';
import { UpdatePurchaseStatusDto } from './dto/update-purchase-status.dto';
import { ExportPurchasesDto } from './dto/export-purchases.dto';
import { S3Service } from '../../common/s3/s3.service';
import { SqsService } from '../../common/sqs/sqs.service';
import { AiWebhookDto } from './dto/ai-webhook.dto';
import { AuditWebhookDto } from './dto/audit-webhook.dto';
import { AdminRole } from '../auth/enums/admin-role.enum';
import { calculatePromotionalTotal } from '../raffles/utils/pricing.util';

@Injectable()
export class PurchasesService {
  private readonly logger = new Logger(PurchasesService.name);

  constructor(
    @InjectRepository(Purchase)
    private purchaseRepository: Repository<Purchase>,
    @InjectRepository(Ticket)
    private ticketRepository: Repository<Ticket>,
    @InjectRepository(PaymentMethod)
    private paymentMethodRepository: Repository<PaymentMethod>,
    @InjectRepository(Currency)
    private currencyRepository: Repository<Currency>,
    private dataSource: DataSource,
    private readonly s3Service: S3Service,
    private readonly sqsService: SqsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ===========================================================================
  // PUBLIC METHODS
  // ===========================================================================

  /**
   * Creates a new purchase.
   * Handles both RANDOM and SPECIFIC raffle selection types.
   * If SPECIFIC, tickets are reserved immediately in PENDING status.
   */
  async create(
    createDto: CreatePurchaseDto,
    file: Express.Multer.File | undefined,
  ) {
    const createdPurchase = await this.dataSource.transaction(async (manager) => {
      // 1. Recuperar Raffle (findOne con lock) para ticketPrice y config de promociones
      const raffle = await this.lockAndValidateRaffle(
        manager,
        createDto.raffleId,
      );

      // 2. Recuperar PaymentMethod para obtener currency.value (tasa de cambio)
      const paymentMethod = await manager.findOne(PaymentMethod, {
        where: { uid: createDto.paymentMethodId },
        relations: ['currency'],
      });
      if (!paymentMethod) {
        throw new NotFoundException('Payment method not found');
      }
      const unitPriceInPaymentCurrency =
        Number(raffle.ticketPrice) *
        Number(paymentMethod.currency?.value ?? 1);
      const calculatedTotal = calculatePromotionalTotal(
        unitPriceInPaymentCurrency,
        createDto.ticket_quantity,
        raffle.promotionStrategy ?? null,
        raffle.promotionConfig ?? null,
      );
      const totalAmountToPersist = Number(calculatedTotal.toFixed(2));

      // 3. Validate Capacity & Reserve Tickets Strategy
      // Returns specific numbers if selected, or null if random (to be assigned later)
      const ticketNumbers = await this.determineTicketAllocation(
        manager,
        raffle,
        createDto,
      );

      // 4. Customer & File Handling
      const customer = await this.getOrCreateCustomer(
        manager,
        createDto.customer,
      );
      const screenshotKey = await this.uploadPaymentScreenshot(
        file,
        createDto.raffleId,
      );

      // 5. Persistence — Seguridad: no usar createDto.totalAmount; el backend es la única fuente de verdad del total.
      const purchase = manager.create(Purchase, {
        raffleId: createDto.raffleId,
        paymentMethodId: createDto.paymentMethodId,
        ticketQuantity: createDto.ticket_quantity,
        totalAmount: totalAmountToPersist,
        bankReference: createDto.bank_reference,
        paymentScreenshotUrl: screenshotKey,
        customerId: customer.uid,
        status: PurchaseStatus.PENDING,
        ticketNumbers: ticketNumbers, // Saved immediately for SPECIFIC type
      });

      return await manager.save(Purchase, purchase);
    });

    // 5. Post-Process (Async Notifications)
    await this.notifyPostPurchase(createdPurchase, 'created');

    return createdPurchase;
  }

  /**
   * Handles webhook from legacy/audit systems.
   * Supports migrating existing purchases with or without specific ticket numbers.
   */
  async processAuditWebhook(
    webhook: AuditWebhookDto,
    file: Express.Multer.File | undefined,
  ) {
    if (!file && !webhook.payment_screenshot) {
      throw new BadRequestException(
        'Payment screenshot (file or URL) is required',
      );
    }

    const createdPurchase = await this.dataSource.transaction(async (manager) => {
      // Resolve external IDs to internal Entities
      const raffle = await this.resolveRaffle(manager, webhook.raffle_id);
      const paymentMethod = await this.resolvePaymentMethod(
        manager,
        webhook.payment_method_id,
        webhook.payment_method_name,
      );

      const customer = await this.getOrCreateCustomer(manager, {
        nationalId: webhook.national_id,
        fullName: webhook.full_name,
        email: webhook.email,
        phone: webhook.phone,
      });

      let screenshotKey = webhook.payment_screenshot;
      if (file) {
        screenshotKey = await this.uploadPaymentScreenshot(file, raffle.uid);
      }

      const purchase = manager.create(Purchase, {
        raffleId: raffle.uid,
        paymentMethodId: paymentMethod.uid,
        customerId: customer.uid,
        totalAmount: Number(webhook.total_amount),
        bankReference: webhook.bank_reference,
        ticketQuantity: Number(webhook.ticket_quantity),
        paymentScreenshotUrl: screenshotKey,
        status: (webhook.status as PurchaseStatus) || PurchaseStatus.PENDING,
        submittedAt: webhook.created_at
          ? new Date(webhook.created_at)
          : new Date(),
        verifiedAt:
          webhook.status === PurchaseStatus.VERIFIED ? new Date() : null,
      });

      // If legacy system provided specific numbers, map them
      if (webhook.ticket_numbers && Array.isArray(webhook.ticket_numbers)) {
        purchase.ticketNumbers = webhook.ticket_numbers.map(Number);
      }

      // Note: If VERIFIED and no numbers provided, we might want to auto-assign here.
      // Logic left optional based on business requirements.

      return await manager.save(Purchase, purchase);
    });

    await this.notifyPostPurchase(createdPurchase, 'created_audit');
    return createdPurchase;
  }

  /**
   * Handles the AI Lambda webhook response.
   * Validates Amount, Currency, and Reference against AI extraction.
   */
  async processAiWebhook(webhook: AiWebhookDto) {
    const { purchaseId, aiResult } = webhook;

    return this.dataSource.transaction(async (manager) => {
      const purchase = await manager.findOne(Purchase, {
        where: { uid: purchaseId },
        relations: ['raffle', 'paymentMethod', 'paymentMethod.currency'],
      });
      if (!purchase) throw new NotFoundException('Purchase not found');

      const wasVerified = purchase.status === PurchaseStatus.VERIFIED;

      // Save raw AI result for auditing
      purchase.aiAnalysisResult = aiResult ?? null;

      interface ReceiptData {
        amount: number | null;
        currency: string | null;
        reference: string | null;
      }
      const aiData = aiResult as ReceiptData;

      // --- Validation Phase ---

      // A. Basic Integrity Check
      if (!aiData?.amount || !aiData?.currency || !aiData?.reference) {
        return this.handleManualReview(
          manager,
          purchase,
          'Purchase requires manual review (insufficient AI data)',
        );
      }

      // B. Duplicate Check (Fuzzy Reference Matching)
      const normalizedAiRef = this.normalizeReference(aiData.reference);
      // Si por alguna razón la referencia normalizada queda vacía, enviamos a revisión manual
      if (!normalizedAiRef) {
        return this.handleManualReview(
          manager,
          purchase,
          'Purchase requires manual review (empty normalized reference)',
        );
      }
      const existingWithRef = await manager
        .getRepository(Purchase)
        .createQueryBuilder('p')
        .where('p.uid != :uid', { uid: purchaseId })
        .andWhere(
          "REGEXP_REPLACE(UPPER(p.bank_reference), '[^A-Z0-9]', '', 'g') = :ref",
          { ref: normalizedAiRef },
        )
        .getOne();

      if (existingWithRef) {
        purchase.status = PurchaseStatus.DUPLICATED;
        const saved = await manager.save(Purchase, purchase);
        this.emitStatusChange(
          saved,
          'duplicated',
          'Purchase marked as duplicated',
        );
        return this.serializePurchase(saved);
      }

      // C. Amount Check (0.01 tolerance)
      const amountDiff = Math.abs(purchase.totalAmount - aiData.amount);
      const isAmountValid = amountDiff < 0.01;

      // D. Currency Check
      const expectedCurrency = purchase.paymentMethod?.currency;
      const isCurrencyValid = expectedCurrency?.symbol === aiData.currency;

      // E. Reference Check (Improved: endsWith OR contains for better matching)
      const normalizedUserRef = this.normalizeReference(purchase.bankReference);

      // Log para depuración
      this.logger.debug(
        `Reference validation for purchase ${purchaseId}: ` +
        `UserRef="${purchase.bankReference}" -> Normalized="${normalizedUserRef}", ` +
        `AiRef="${aiData.reference}" -> Normalized="${normalizedAiRef}", ` +
        `Amount: ${purchase.totalAmount} vs ${aiData.amount} (diff=${amountDiff.toFixed(4)}), ` +
        `Currency: ${expectedCurrency?.symbol} vs ${aiData.currency}`
      );

      let isRefValid = false;
      if (normalizedUserRef && normalizedAiRef) {
        // Verificar si una termina con la otra (caso original)
        const endsWithMatch =
          normalizedAiRef.endsWith(normalizedUserRef) ||
          normalizedUserRef.endsWith(normalizedAiRef);

        // Verificar si una contiene a la otra (para casos como 413134749064265728 contiene 265728)
        const containsMatch =
          normalizedAiRef.includes(normalizedUserRef) ||
          normalizedUserRef.includes(normalizedAiRef);

        // Aceptar si hay coincidencia por endsWith O si la referencia más corta tiene al menos 4 caracteres y está contenida
        const minLengthForContains = 4;
        const shorterRef = normalizedUserRef.length <= normalizedAiRef.length
          ? normalizedUserRef
          : normalizedAiRef;
        const longerRef = normalizedUserRef.length > normalizedAiRef.length
          ? normalizedUserRef
          : normalizedAiRef;

        isRefValid = endsWithMatch ||
          (containsMatch && shorterRef.length >= minLengthForContains && longerRef.includes(shorterRef));
      }

      // --- Decision Phase ---

      if (isAmountValid && isRefValid) {
        purchase.status = PurchaseStatus.VERIFIED;
        purchase.verifiedAt = new Date();
      } else {
        // Log detallado del motivo de falla
        this.logger.warn(
          `AI Validation Failed for purchase ${purchaseId}: ` +
          `Amount=${isAmountValid} (${purchase.totalAmount} vs ${aiData.amount}), ` +
          `Ref=${isRefValid} (User: "${normalizedUserRef}", AI: "${normalizedAiRef}")`
        );
        return this.handleManualReview(
          manager,
          purchase,
          `AI Validation Failed: Amount=${isAmountValid}, Ref=${isRefValid}`,
        );
      }

      // If transition to VERIFIED -> Persist aiAnalysisResult, status, verifiedAt; then assign tickets if needed
      if (purchase.status === PurchaseStatus.VERIFIED && !wasVerified) {
        const saved = await manager.save(Purchase, purchase);
        this.emitStatusChange(saved, 'verified', 'AI validation passed');
        await this.assignTickets(manager, saved);
        return this.serializePurchase(saved);
      }

      const updatedPurchase = await manager.save(Purchase, purchase);
      return this.serializePurchase(updatedPurchase);
    });
  }

  /**
   * Manual Status Update by Admin.
   * Triggers ticket assignment if status changes to VERIFIED.
   * Only SUPER_ADMIN can revert a purchase that is already VERIFIED.
   */
  async updateStatus(uid: string, updateDto: UpdatePurchaseStatusDto, adminRole: AdminRole) {
    const { status } = updateDto;

    return this.dataSource.transaction(async (manager) => {
      const purchase = await manager.findOne(Purchase, { where: { uid } });
      if (!purchase) throw new NotFoundException('Purchase not found');

      // Business rule: VERIFIER can only verify, not reject
      if (adminRole === AdminRole.VERIFIER && status === PurchaseStatus.REJECTED) {
        throw new ForbiddenException('Verifiers cannot reject purchases. Only verification is allowed.');
      }

      // Business rule: Only SUPER_ADMIN can revert a verified purchase
      if (purchase.status === PurchaseStatus.VERIFIED && adminRole !== AdminRole.SUPER_ADMIN) {
        throw new ForbiddenException('Only Super Admin can revert a verified purchase');
      }

      purchase.status = status;

      if (status === PurchaseStatus.VERIFIED) {
        purchase.verifiedAt = new Date();
      }
      await manager.save(Purchase, purchase);

      this.eventEmitter.emit('purchase.status_changed', {
        type: 'status_changed',
        msg: `Purchase status changed to ${status}`,
        raffleId: purchase.raffleId,
        purchaseId: purchase.uid,
        status,
      });

      return purchase;
    });
  }

  /**
   * Full update of a purchase (Super Admin only).
   * All fields are optional; only provided fields are updated.
   * Runs in a transaction. Validates raffle, payment method, customer, and ticket numbers when provided.
   */
  async update(
    uid: string,
    updateDto: UpdatePurchaseDto,
    file?: Express.Multer.File,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const purchase = await manager.findOne(Purchase, {
        where: { uid },
        relations: ['raffle', 'paymentMethod', 'customer'],
      });
      if (!purchase) throw new NotFoundException('Purchase not found');

      if (updateDto.raffleId !== undefined) {
        const raffle = await manager.findOne(Raffle, {
          where: { uid: updateDto.raffleId },
        });
        if (!raffle) throw new NotFoundException('Raffle not found');
        if (raffle.status !== RaffleStatus.ACTIVE) {
          throw new BadRequestException('Raffle is not active');
        }
        purchase.raffleId = updateDto.raffleId;
      }

      if (updateDto.paymentMethodId !== undefined) {
        const paymentMethod = await manager.findOne(PaymentMethod, {
          where: { uid: updateDto.paymentMethodId },
        });
        if (!paymentMethod) {
          throw new NotFoundException('Payment method not found');
        }
        purchase.paymentMethodId = updateDto.paymentMethodId;
      }

      if (updateDto.customer !== undefined) {
        const customer = await this.getOrCreateCustomer(manager, updateDto.customer);
        purchase.customerId = customer.uid;
      } else if (updateDto.customerId !== undefined) {
        const customer = await manager.findOne(Customer, {
          where: { uid: updateDto.customerId },
        });
        if (!customer) throw new NotFoundException('Customer not found');
        purchase.customerId = updateDto.customerId;
      }

      const raffle = purchase.raffle ?? (await manager.findOne(Raffle, { where: { uid: purchase.raffleId } }));

      if (updateDto.ticket_numbers !== undefined) {
        const numbers = updateDto.ticket_numbers;
        if (numbers.length === 0) {
          throw new BadRequestException('ticket_numbers must contain at least one number');
        }
        if (updateDto.ticket_quantity !== undefined && numbers.length !== updateDto.ticket_quantity) {
          throw new BadRequestException(
            `ticket_quantity (${updateDto.ticket_quantity}) must match ticket_numbers length (${numbers.length})`,
          );
        }
        if (!raffle) throw new NotFoundException('Raffle not found');
        const uniqueNumbers = new Set(numbers);
        if (uniqueNumbers.size !== numbers.length) {
          throw new BadRequestException('ticket_numbers contains duplicates');
        }
        const invalid = numbers.filter((n) => n < 0 || n >= raffle.totalTickets);
        if (invalid.length > 0) {
          throw new BadRequestException(
            `Invalid ticket numbers (out of range): ${invalid.join(', ')}`,
          );
        }
        const occupiedCount = await this.countOccupiedTickets(
          manager,
          raffle.uid,
          numbers,
          purchase.uid,
        );
        if (occupiedCount > 0) {
          throw new ConflictException(
            'Some selected tickets are already reserved or verified by another purchase.',
          );
        }
        purchase.ticketNumbers = numbers;
        purchase.ticketQuantity = numbers.length;
      } else if (updateDto.ticket_quantity !== undefined) {
        const existingCount = purchase.ticketNumbers?.length ?? 0;
        if (existingCount > 0 && updateDto.ticket_quantity !== existingCount) {
          throw new BadRequestException(
            `ticket_quantity must match the number of assigned tickets (${existingCount})`,
          );
        }
        purchase.ticketQuantity = updateDto.ticket_quantity;
      }

      if (file) {
        const key = await this.uploadPaymentScreenshot(file, purchase.raffleId);
        if (key) purchase.paymentScreenshotUrl = key;
      } else if (updateDto.payment_screenshot_url !== undefined) {
        purchase.paymentScreenshotUrl = updateDto.payment_screenshot_url;
      }

      if (updateDto.notes !== undefined) purchase.notes = updateDto.notes;
      if (updateDto.bank_reference !== undefined) purchase.bankReference = updateDto.bank_reference;
      if (updateDto.status !== undefined) {
        purchase.status = updateDto.status;
        if (updateDto.status === PurchaseStatus.VERIFIED && !purchase.verifiedAt) {
          purchase.verifiedAt = new Date();
        }
      }
      if (updateDto.totalAmount !== undefined) purchase.totalAmount = updateDto.totalAmount;

      const ticketNumbersLength = purchase.ticketNumbers?.length;
      if (ticketNumbersLength != null && purchase.ticketQuantity !== ticketNumbersLength) {
        throw new BadRequestException(
          `ticket_quantity (${purchase.ticketQuantity}) must equal the number of assigned tickets (${ticketNumbersLength})`,
        );
      }

      await manager.save(Purchase, purchase);
    });

    return this.findOne(uid);
  }

  async findAll(query: Record<string, unknown>) {
    const raffleId =
      typeof query.raffleId === 'string' ? query.raffleId : undefined;
    const status = typeof query.status === 'string' ? query.status : undefined;
    const nationalId =
      typeof query.nationalId === 'string' ? query.nationalId : undefined;
    const bankReference =
      typeof query.bankReference === 'string' ? query.bankReference : undefined;
    const currency =
      typeof query.currency === 'string' ? query.currency : undefined;
    const paymentMethodId =
      typeof query.paymentMethodId === 'string'
        ? query.paymentMethodId
        : undefined;
    const ticketNumberRaw = query.ticketNumber;
    const ticketNumber =
      typeof ticketNumberRaw === 'string' || typeof ticketNumberRaw === 'number'
        ? Number(ticketNumberRaw)
        : undefined;
    const customerName =
      typeof query.customerName === 'string' ? query.customerName : undefined;
    const email =
      typeof query.email === 'string' ? query.email : undefined;
    const phone =
      typeof query.phone === 'string' ? query.phone : undefined;
    const dateFrom =
      typeof query.dateFrom === 'string' ? query.dateFrom : undefined;
    const dateTo =
      typeof query.dateTo === 'string' ? query.dateTo : undefined;

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
    if (bankReference) {
      qb.andWhere('purchase.bankReference ILIKE :bankReference', {
        bankReference: `%${bankReference}%`,
      });
    }
    if (currency) {
      qb.andWhere('currency.symbol = :currency', { currency });
    }
    if (paymentMethodId) {
      qb.andWhere('purchase.paymentMethodId = :paymentMethodId', {
        paymentMethodId,
      });
    }
    if (ticketNumber !== undefined && !Number.isNaN(ticketNumber)) {
      qb.andWhere(':ticketNumber = ANY(purchase.ticketNumbers)', {
        ticketNumber,
      });
    }
    if (customerName) {
      qb.andWhere('customer.fullName ILIKE :customerName', {
        customerName: `%${customerName}%`,
      });
    }
    if (email) {
      qb.andWhere('customer.email ILIKE :email', {
        email: `%${email}%`,
      });
    }
    if (phone) {
      qb.andWhere('customer.phone ILIKE :phone', {
        phone: `%${phone}%`,
      });
    }
    if (dateFrom) {
      const dateFromStart = new Date(dateFrom);
      dateFromStart.setHours(0, 0, 0, 0);
      qb.andWhere('purchase.submittedAt >= :dateFrom', { dateFrom: dateFromStart });
    }
    if (dateTo) {
      // Add one day to include the entire end date
      const dateToEnd = new Date(dateTo);
      dateToEnd.setHours(23, 59, 59, 999);
      qb.andWhere('purchase.submittedAt <= :dateTo', { dateTo: dateToEnd });
    }

    const [items, total] = await qb.getManyAndCount();

    const signedItems = items.map((purchase) => {
      const paymentScreenshotUrl = this.s3Service.getCdnUrl(
        purchase.paymentScreenshotUrl,
      );
      const raffleImageUrl = this.s3Service.getCdnUrl(
        purchase.raffle?.imageUrl,
      );
      const paymentMethodImageUrl = this.s3Service.getCdnUrl(
        purchase.paymentMethod?.imageUrl,
      );

      const { currency, ...paymentMethodRest } =
        purchase.paymentMethod || {};
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
    });

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
      relations: [
        'customer',
        'raffle',
        'paymentMethod',
        'paymentMethod.currency',
      ],
    });
    if (!purchase) throw new NotFoundException('Purchase not found');

    const paymentScreenshotUrl = this.s3Service.getCdnUrl(
      purchase.paymentScreenshotUrl,
    );
    const raffleImageUrl = this.s3Service.getCdnUrl(
      purchase.raffle?.imageUrl,
    );
    const paymentMethodImageUrl = this.s3Service.getCdnUrl(
      purchase.paymentMethod?.imageUrl,
    );

    const { currency, ...paymentMethodRest } = purchase.paymentMethod || {};
    return {
      ...purchase,
      ticketNumbers: purchase.ticketNumbers || [],
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

  async exportPurchases(filters: ExportPurchasesDto): Promise<Buffer> {
    const {
      raffleId,
      currency,
      status,
      nationalId,
      bankReference,
      paymentMethodId,
      ticketNumber,
      customerName,
      email,
      phone,
      dateFrom,
      dateTo,
    } = filters;

    // 1. Get payment methods
    const paymentMethodsQb = this.paymentMethodRepository
      .createQueryBuilder('pm')
      .leftJoinAndSelect('pm.currency', 'currency');

    if (currency) {
      paymentMethodsQb.andWhere('currency.symbol = :currency', { currency });
    }
    const paymentMethods = await paymentMethodsQb.getMany();

    // 2. Query purchases
    const qb = this.purchaseRepository
      .createQueryBuilder('purchase')
      .leftJoinAndSelect('purchase.customer', 'customer')
      .leftJoinAndSelect('purchase.raffle', 'raffle')
      .leftJoinAndSelect('purchase.paymentMethod', 'paymentMethod')
      .leftJoinAndSelect('paymentMethod.currency', 'pmCurrency')
      .orderBy('purchase.submittedAt', 'DESC');

    if (raffleId) qb.andWhere('purchase.raffleId = :raffleId', { raffleId });
    if (status) qb.andWhere('purchase.status = :status', { status });
    if (nationalId)
      qb.andWhere('customer.nationalId LIKE :nationalId', {
        nationalId: `%${nationalId}%`,
      });
    if (bankReference) {
      qb.andWhere('purchase.bankReference ILIKE :bankReference', {
        bankReference: `%${bankReference}%`,
      });
    }
    if (currency)
      qb.andWhere('pmCurrency.symbol = :currency', { currency });
    if (paymentMethodId)
      qb.andWhere('purchase.paymentMethodId = :paymentMethodId', {
        paymentMethodId,
      });
    if (ticketNumber !== undefined && !Number.isNaN(ticketNumber)) {
      qb.andWhere(':ticketNumber = ANY(purchase.ticketNumbers)', {
        ticketNumber,
      });
    }
    if (customerName) {
      qb.andWhere('customer.fullName ILIKE :customerName', {
        customerName: `%${customerName}%`,
      });
    }
    if (email) {
      qb.andWhere('customer.email ILIKE :email', {
        email: `%${email}%`,
      });
    }
    if (phone) {
      qb.andWhere('customer.phone ILIKE :phone', {
        phone: `%${phone}%`,
      });
    }
    if (dateFrom) {
      const dateFromStart = new Date(dateFrom);
      dateFromStart.setHours(0, 0, 0, 0);
      qb.andWhere('purchase.submittedAt >= :dateFrom', { dateFrom: dateFromStart });
    }
    if (dateTo) {
      // Add one day to include the entire end date
      const dateToEnd = new Date(dateTo);
      dateToEnd.setHours(23, 59, 59, 999);
      qb.andWhere('purchase.submittedAt <= :dateTo', { dateTo: dateToEnd });
    }

    const purchases = await qb.getMany();

    // 3. Group by Payment Method
    const purchasesByPaymentMethod = new Map<string, Purchase[]>();
    paymentMethods.forEach((pm) => purchasesByPaymentMethod.set(pm.uid, []));
    purchases.forEach((p) => {
      const pmId = p.paymentMethodId;
      if (purchasesByPaymentMethod.has(pmId)) {
        purchasesByPaymentMethod.get(pmId)!.push(p);
      }
    });

    // 4. Excel Generation
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Raffles Admin';
    workbook.created = new Date();

    const statusLabels: Record<string, string> = {
      [PurchaseStatus.PENDING]: 'Pendiente',
      [PurchaseStatus.VERIFIED]: 'Verificado',
      [PurchaseStatus.REJECTED]: 'Rechazado',
      [PurchaseStatus.MANUAL_REVIEW]: 'Revisión Manual',
      [PurchaseStatus.DUPLICATED]: 'Duplicado',
    };

    const addHeaders = (worksheet: ExcelJS.Worksheet) => {
      worksheet.columns = [
        { header: 'Fecha', key: 'date', width: 18 },
        { header: 'Cliente', key: 'customer', width: 25 },
        { header: 'Cédula', key: 'nationalId', width: 15 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Teléfono', key: 'phone', width: 15 },
        { header: 'Tickets', key: 'ticketQty', width: 10 },
        { header: 'Monto', key: 'amount', width: 15 },
        { header: 'Referencia', key: 'reference', width: 20 },
        { header: 'Estado', key: 'status', width: 15 },
        { header: 'Rifa', key: 'raffle', width: 25 },
      ];
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' },
      };
    };

    const totals: {
      paymentMethod: string;
      currency: string;
      total: number;
    }[] = [];

    for (const pm of paymentMethods) {
      const pmPurchases = purchasesByPaymentMethod.get(pm.uid) || [];
      const sheetName = pm.name.slice(0, 31).replace(/[*?:/\\[\]]/g, '-');
      const worksheet = workbook.addWorksheet(sheetName);

      addHeaders(worksheet);

      pmPurchases.forEach((p) => {
        worksheet.addRow({
          date: new Date(p.submittedAt).toLocaleString('es-VE'),
          customer: p.customer?.fullName || '-',
          nationalId: p.customer?.nationalId || '-',
          email: p.customer?.email || '-',
          phone: p.customer?.phone || '-',
          ticketQty: p.ticketQuantity,
          amount: Number(p.totalAmount).toFixed(2),
          reference: p.bankReference || '-',
          status: statusLabels[p.status] || p.status,
          raffle: p.raffle?.title || '-',
        });
      });

      const pmTotal = pmPurchases.reduce(
        (sum, p) => sum + Number(p.totalAmount),
        0,
      );
      totals.push({
        paymentMethod: pm.name,
        currency: pm.currency?.symbol || 'USD',
        total: pmTotal,
      });

      worksheet.addRow({});
      const totalRow = worksheet.addRow({
        phone: 'TOTAL:',
        ticketQty: pmPurchases.reduce((sum, p) => sum + p.ticketQuantity, 0),
        amount: pmTotal.toFixed(2),
      });
      totalRow.font = { bold: true };
    }

    // Summary Sheet
    const summaryCurrency = currency || 'Todas';
    const summarySheet = workbook.addWorksheet(`Totales ${summaryCurrency}`);
    summarySheet.columns = [
      { header: 'Método de Pago', key: 'paymentMethod', width: 30 },
      { header: 'Moneda', key: 'currency', width: 10 },
      { header: 'Total', key: 'total', width: 18 },
    ];
    summarySheet.getRow(1).font = { bold: true };

    let grandTotal = 0;
    totals.forEach((t) => {
      summarySheet.addRow(t);
      grandTotal += t.total;
    });

    summarySheet.addRow({});
    const grandTotalRow = summarySheet.addRow({
      paymentMethod: 'TOTAL GENERAL',
      total: grandTotal.toFixed(2),
    });
    grandTotalRow.font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // ===========================================================================
  // PRIVATE BUSINESS LOGIC (Extracted for Clean Code)
  // ===========================================================================

  /**
   * Fetches a Raffle with a Pessimistic Write Lock.
   * Ensures the raffle exists and is active.
   */
  private async lockAndValidateRaffle(
    manager: EntityManager,
    raffleId: string,
  ): Promise<Raffle> {
    const raffle = await manager.findOne(Raffle, {
      where: { uid: raffleId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!raffle) throw new NotFoundException('Raffle not found');
    if (raffle.status !== RaffleStatus.ACTIVE)
      throw new BadRequestException('Raffle is not active');

    return raffle;
  }

  /**
   * Determines how tickets are allocated based on Raffle type.
   */
  private async determineTicketAllocation(
    manager: EntityManager,
    raffle: Raffle,
    dto: CreatePurchaseDto,
  ): Promise<number[] | null> {
    if (raffle.selectionType === RaffleSelectionType.SPECIFIC) {
      return this.validateAndReserveSpecificTickets(manager, raffle, dto);
    } else {
      await this.validateRandomCapacity(manager, raffle, dto.ticket_quantity);
      return null; // Will be assigned later in assignTickets
    }
  }

  /**
   * Validates specific ticket requests.
   * Checks range, duplicates, and availability against DB (Pending or Verified).
   */
  private async validateAndReserveSpecificTickets(
    manager: EntityManager,
    raffle: Raffle,
    dto: CreatePurchaseDto,
  ): Promise<number[]> {
    const requestedNumbers = dto.ticket_numbers;

    // 1. Input Validation
    if (!requestedNumbers || requestedNumbers.length === 0) {
      throw new BadRequestException(
        'ticket_numbers is required for SPECIFIC raffles',
      );
    }
    if (requestedNumbers.length !== dto.ticket_quantity) {
      throw new BadRequestException(
        `Mismatch: quantity=${dto.ticket_quantity} vs provided=${requestedNumbers.length}`,
      );
    }

    // 2. Range & Duplicate Check (In Memory)
    const uniqueRequested = new Set(requestedNumbers);
    if (uniqueRequested.size !== requestedNumbers.length) {
      throw new BadRequestException('ticket_numbers contains duplicates');
    }
    const invalid = requestedNumbers.filter(
      (n) => n < 0 || n >= raffle.totalTickets,
    );
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Invalid numbers (out of range): ${invalid.join(', ')}`,
      );
    }

    // 3. Database Availability Check
    const occupiedCount = await this.countOccupiedTickets(
      manager,
      raffle.uid,
      requestedNumbers,
    );

    if (occupiedCount > 0) {
      throw new ConflictException(
        'Some selected tickets are already reserved or verified.',
      );
    }

    return requestedNumbers;
  }

  /**
   * Validates capacity for random raffles.
   */
  private async validateRandomCapacity(
    manager: EntityManager,
    raffle: Raffle,
    quantity: number,
  ): Promise<void> {
    // Count ALL tickets currently occupied (Verified or Pending)
    const result = await manager.query(
      `SELECT SUM(ticket_quantity) as total
         FROM purchase
         WHERE raffle_id = $1
         AND status IN ($2, $3)`,
      [raffle.uid, PurchaseStatus.PENDING, PurchaseStatus.VERIFIED],
    );

    const occupied = parseInt(result[0]?.total || '0', 10);
    const available = raffle.totalTickets - occupied;

    if (available < quantity) {
      throw new ConflictException(`Not enough tickets. Available: ${available}`);
    }
  }

  /**
   * Helper to count how many of the requested numbers are already taken.
   * Checks PENDING and VERIFIED statuses.
   * @param excludePurchaseId - When provided (e.g. on update), excludes this purchase from the count.
   */
  private async countOccupiedTickets(
    manager: EntityManager,
    raffleId: string,
    numbersToCheck: number[],
    excludePurchaseId?: string,
  ): Promise<number> {
    const params: (string | number | string[] | number[])[] = [
      raffleId,
      PurchaseStatus.PENDING,
      PurchaseStatus.VERIFIED,
      numbersToCheck,
    ];
    const excludeClause = excludePurchaseId ? ' AND purchase.uid != $5' : '';
    if (excludePurchaseId) params.push(excludePurchaseId);

    const result = await manager.query(
      `SELECT COUNT(*) as count
       FROM purchase, unnest(ticket_numbers) as t_num
       WHERE purchase.raffle_id = $1
       AND purchase.status IN ($2, $3)
       AND t_num = ANY($4)${excludeClause}`,
      params,
    );
    return parseInt(result[0]?.count || '0', 10);
  }

  // ===========================================================================
  // OTHER HELPERS (Customer, S3, Notifications, AssignTickets)
  // ===========================================================================

  /**
   * Normaliza referencias alfanuméricas para comparaciones seguras.
   * - Convierte a mayúsculas
   * - Elimina todo lo que no sea letra ni dígito (espacios, guiones, etc.)
   */
  private normalizeReference(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const upper = String(raw).toUpperCase();
    const cleaned = upper.replace(/[^A-Z0-9]/g, '');
    return cleaned || null;
  }

  private async getOrCreateCustomer(
    manager: EntityManager,
    data: any,
  ): Promise<Customer> {
    const rawNationalId = data.national_id || data.nationalId;
    const normalizedNationalId =
      typeof rawNationalId === 'string'
        ? rawNationalId.replace(/\D/g, '') || null
        : null;

    const existingCustomer = await manager.findOne(Customer, {
      where: { nationalId: normalizedNationalId },
    });

    if (existingCustomer) {
      existingCustomer.fullName = data.full_name || data.fullName;
      existingCustomer.email = data.email;
      existingCustomer.phone = data.phone || existingCustomer.phone;
      return await manager.save(Customer, existingCustomer);
    }

    const newCustomer = manager.create(Customer, {
      nationalId: normalizedNationalId,
      fullName: data.full_name || data.fullName,
      email: data.email,
      phone: data.phone,
    });
    return await manager.save(Customer, newCustomer);
  }

  private async uploadPaymentScreenshot(
    file: Express.Multer.File,
    raffleId: string,
  ): Promise<string> {
    if (!file) return null;
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');

    const { key } = await this.s3Service.uploadBuffer({
      keyPrefix: `purchases/${raffleId}/${year}/${month}`,
      originalName: file.originalname,
      buffer: file.buffer,
      contentType: file.mimetype,
    });
    return key;
  }

  private async resolveRaffle(
    manager: EntityManager,
    id: string,
  ): Promise<Raffle> {
    let raffle = await manager.findOne(Raffle, { where: { externalId: id } });
    if (!raffle && this.isUUID(id)) {
      raffle = await manager.findOne(Raffle, { where: { uid: id } });
    }
    if (!raffle) {
      throw new NotFoundException(`Raffle not found (ID: ${id})`);
    }
    return raffle;
  }

  private async resolvePaymentMethod(
    manager: EntityManager,
    id: string,
    name?: string,
  ): Promise<PaymentMethod> {
    let pm = await manager.findOne(PaymentMethod, { where: { externalId: id } });
    if (!pm && this.isUUID(id)) {
      pm = await manager.findOne(PaymentMethod, { where: { uid: id } });
    }
    if (!pm && name) {
      pm = await manager.findOne(PaymentMethod, {
        where: { name: ILike(name) },
      });
    }
    if (!pm) {
      throw new NotFoundException(`Payment method not found (ID: ${id})`);
    }
    return pm;
  }

  private async notifyPostPurchase(purchase: Purchase, eventType: string) {
    // 1. Send to SQS
    try {
      await this.sqsService.sendPurchaseCreatedMessage(purchase);
    } catch (err) {
      this.logger.error(
        'Failed to send purchase created message to SQS.',
        err instanceof Error ? err.stack : String(err),
      );
    }

    // 2. Emit Real-time Event
    this.eventEmitter.emit('purchase.created', {
      type: eventType,
      msg: 'New purchase created',
      raffleId: purchase.raffleId,
      purchaseId: purchase.uid,
    });
  }

  /**
   * Assigns ticket numbers for RANDOM type raffles.
   * Ensures new random numbers do not collide with existing reserved or verified tickets.
   */
  private async assignTickets(
    manager: EntityManager,
    purchase: Purchase,
  ): Promise<void> {
    // If tickets are already assigned (SPECIFIC type), skip.
    if (purchase.ticketNumbers && purchase.ticketNumbers.length > 0) return;

    const raffle = await manager.findOne(Raffle, {
      where: { uid: purchase.raffleId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!raffle) throw new NotFoundException('Raffle not found');

    // Get SET of currently occupied numbers (Pending or Verified)
    // We must exclude the current purchase from the check (though it has no numbers yet)
    const takenTicketsRaw = await manager.query(
      `SELECT unnest("ticket_numbers") as num FROM purchase
       WHERE "raffle_id" = $1
       AND "ticket_numbers" IS NOT NULL
       AND "status" IN ($2, $3)
       AND uid != $4`,
      [
        raffle.uid,
        PurchaseStatus.PENDING,
        PurchaseStatus.VERIFIED,
        purchase.uid,
      ],
    );

    const soldSet = new Set<number>(
      takenTicketsRaw.map((s: { num: number }) => Number(s.num)),
    );
    const available = raffle.totalTickets - soldSet.size;

    if (available < purchase.ticketQuantity) {
      throw new ConflictException('Not enough tickets available.');
    }

    // Random Generation
    const toAssign: number[] = [];
    const maxAttempts = purchase.ticketQuantity * 10;
    let attempts = 0;

    while (
      toAssign.length < purchase.ticketQuantity &&
      attempts < maxAttempts
    ) {
      const randomNum = Math.floor(Math.random() * raffle.totalTickets);
      // Ensure no collision with SoldSet AND no duplicates within the current assignment batch
      if (!soldSet.has(randomNum) && !toAssign.includes(randomNum)) {
        toAssign.push(randomNum);
      }
      attempts++;
    }

    if (toAssign.length < purchase.ticketQuantity) {
      throw new ConflictException(
        'Could not assign tickets (congestion). Try again.',
      );
    }

    purchase.ticketNumbers = toAssign;
    await manager.save(Purchase, purchase);

    // Notification for specific assignment (optional, if needed for email/sms)
    // this.eventEmitter.emit(...)
  }

  private isUUID(uuid: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      uuid,
    );
  }

  private async handleManualReview(
    manager: EntityManager,
    purchase: Purchase,
    reason: string,
  ) {
    purchase.status = PurchaseStatus.MANUAL_REVIEW;
    const saved = await manager.save(Purchase, purchase);
    this.emitStatusChange(saved, 'manual_review', reason);
    return this.serializePurchase(saved);
  }

  private emitStatusChange(purchase: Purchase, type: string, msg: string) {
    this.eventEmitter.emit('purchase.status_changed', {
      type,
      msg,
      raffleId: purchase.raffleId,
      purchaseId: purchase.uid,
      status: purchase.status,
    });
  }

  private serializePurchase(p: Purchase) {
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
  }
}