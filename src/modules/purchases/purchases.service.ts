import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  Repository,
  ILike,
  Brackets,
  Between,
  In,
} from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Response } from 'express';
import {
  Purchase,
  PurchaseStatus,
  VerificationSource,
  PaymentEntry,
  PromotionSnapshot,
} from './entities/purchase.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { Customer } from '../customers/entities/customer.entity';
import { trimCustomerData } from '../customers/utils/trim-customer-data';
import {
  Raffle,
  RaffleSelectionType,
  RaffleStatus,
} from '../raffles/entities/raffle.entity';
import { PaymentMethod } from '../payments/entities/payment-method.entity';
import { Currency } from '../currencies/entities/currency.entity';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { UpdatePurchaseDto } from './dto/update-purchase.dto';
import { UpdatePurchaseStatusDto } from './dto/update-purchase-status.dto';
import { ExportPurchasesDto } from './dto/export-purchases.dto';
import { ExportReceiptsDto } from './dto/export-receipts.dto';
import { S3Service } from '../../common/s3/s3.service';
import { SqsService } from '../../common/sqs/sqs.service';
import { VENEZUELA_TIMEZONE } from '../../common/utils/date.util';
import { AiWebhookDto } from './dto/ai-webhook.dto';
import { AuditWebhookDto } from './dto/audit-webhook.dto';
import { Admin } from '../auth/entities/admin.entity';
import { AdminRole } from '../auth/enums/admin-role.enum';
import { calculatePromotionalTotal } from '../raffles/utils/pricing.util';
import {
  RaffleOrdersSummaryCurrencyDto,
  RaffleOrdersSummaryResponseDto,
  RaffleOrdersSummaryTotalsDto,
} from './dto/purchases-summary.dto';
import { PurchasesExportService } from './services/purchases-export.service';
import { PurchaseVerificationService } from './services/purchase-verification.service';
import { TicketAllocationService } from './services/ticket-allocation.service';
import { CouponsService } from '../coupons/coupons.service';
import { Coupon } from '../coupons/entities/coupon.entity';
import { AuditEventPayload } from '../audit-logs/dto/audit-event.payload';
import { SpinsService } from '../spins/spins.service';

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
    private readonly exportService: PurchasesExportService,
    private readonly verificationService: PurchaseVerificationService,
    private readonly allocationService: TicketAllocationService,
    private readonly couponsService: CouponsService,
    private readonly spinsService: SpinsService,
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
    const result = await this.dataSource.transaction(async (manager) => {
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
        throw new NotFoundException('Método de pago no encontrado');
      }
      const unitPriceInPaymentCurrency =
        Number(raffle.ticketPrice) * Number(paymentMethod.currency?.value ?? 1);
      const calculatedTotal = calculatePromotionalTotal(
        unitPriceInPaymentCurrency,
        createDto.ticket_quantity,
        raffle.promotionStrategy ?? null,
        raffle.promotionConfig ?? null,
      );

      // 2b. Process coupons (validated + locked inside transaction)
      let validatedCoupons: Coupon[] = [];
      let couponDiscount = 0;
      if (createDto.couponCodes && createDto.couponCodes.length > 0) {
        const uniqueCodes = [
          ...new Set(createDto.couponCodes.map((c) => c.trim().toUpperCase())),
        ];
        if (uniqueCodes.length > createDto.ticket_quantity) {
          throw new BadRequestException(
            `No se pueden usar más cupones (${uniqueCodes.length}) que tickets comprados (${createDto.ticket_quantity})`,
          );
        }
        validatedCoupons = await this.couponsService.validateAndLock(
          uniqueCodes,
          manager,
        );
        couponDiscount = validatedCoupons.length * unitPriceInPaymentCurrency;
      }

      const totalAmountToPersist = Number(
        Math.max(0, calculatedTotal - couponDiscount).toFixed(2),
      );
      const requestedTotalAmount = Number(createDto.totalAmount);
      const totalDiff = Math.abs(requestedTotalAmount - totalAmountToPersist);
      if (Number.isFinite(requestedTotalAmount) && totalDiff > 0.01) {
        throw new BadRequestException(
          'El monto total no coincide con el precio promocional vigente.',
        );
      }

      const originalAmount = Number(
        (unitPriceInPaymentCurrency * createDto.ticket_quantity).toFixed(2),
      );
      const discountAmount = Number(
        (originalAmount - Number(calculatedTotal.toFixed(2))).toFixed(2),
      );
      const promotionSnapshot: PromotionSnapshot | null =
        discountAmount > 0.01 && raffle.promotionStrategy
          ? {
              strategy: raffle.promotionStrategy,
              config: raffle.promotionConfig,
              originalAmount,
              discountAmount,
            }
          : null;

      // 3. Validate Capacity & Reserve Tickets Strategy
      // Returns specific numbers if selected, or null if random (to be assigned later)
      const ticketNumbers =
        await this.allocationService.determineAllocationStrategy(
          manager,
          raffle,
          createDto,
        );

      // 4. Customer & File Handling
      const customer = await this.getOrCreateCustomer(
        manager,
        createDto.customer,
      );

      // ── Blacklist Guard ──
      if (customer.isBlacklisted) {
        throw new ForbiddenException(
          'Este cliente se encuentra bloqueado y no puede realizar compras.',
        );
      }

      const screenshotKey = await this.uploadPaymentScreenshot(
        file,
        createDto.raffleId,
      );

      // 5. Build payments array (multi-payment or backward-compat single)
      const currencySymbol = paymentMethod.currency?.symbol ?? '';
      let paymentsArray: PaymentEntry[];

      if (createDto.payments && createDto.payments.length > 0) {
        paymentsArray = createDto.payments.map((p) => ({
          amount: Number(p.amount),
          reference: p.reference,
          currency: p.currency || currencySymbol,
          evidenceUrl: p.evidenceUrl || screenshotKey || '',
          verified: false,
          paymentMethodId: p.paymentMethodId || createDto.paymentMethodId,
          paymentMethodName: p.paymentMethodName || paymentMethod.name,
          metadata: p.metadata,
        }));
      } else {
        paymentsArray = [
          {
            amount: totalAmountToPersist,
            reference: createDto.bank_reference || '',
            currency: currencySymbol,
            evidenceUrl: screenshotKey || '',
            verified: false,
            paymentMethodId: createDto.paymentMethodId,
            paymentMethodName: paymentMethod.name,
            metadata: createDto.metadata,
          },
        ];
      }

      const totalPaid = paymentsArray.reduce((sum, p) => sum + p.amount, 0);

      // 6. Persistence — Seguridad: no usar createDto.totalAmount; el backend es la única fuente de verdad del total.
      const purchase = manager.create(Purchase, {
        raffleId: createDto.raffleId,
        paymentMethodId: createDto.paymentMethodId,
        ticketQuantity: createDto.ticket_quantity,
        totalAmount: totalAmountToPersist,
        promotionSnapshot,
        bankReference:
          createDto.bank_reference || paymentsArray[0]?.reference || '',
        paymentScreenshotUrl: screenshotKey,
        customerId: customer.uid,
        status: PurchaseStatus.PENDING,
        ticketNumbers: ticketNumbers, // Saved immediately for SPECIFIC type
        payments: paymentsArray,
        totalPaid,
      });

      const savedPurchase = await manager.save(Purchase, purchase);

      // 8b. Redeem coupons
      if (validatedCoupons.length > 0) {
        await this.couponsService.redeemCoupons(
          validatedCoupons,
          savedPurchase.uid,
          manager,
        );
      }

      // 8c. Auto-verify if fully covered by coupons
      if (totalAmountToPersist === 0 && validatedCoupons.length > 0) {
        savedPurchase.status = PurchaseStatus.VERIFIED;
        savedPurchase.verifiedAt = new Date();
        savedPurchase.verificationSource = VerificationSource.BY_SYSTEM;
        savedPurchase.exportedToSheets = false;
        if (
          !savedPurchase.ticketNumbers ||
          savedPurchase.ticketNumbers.length === 0
        ) {
          await this.allocationService.assignRandomNumbers(
            manager,
            savedPurchase.raffleId,
            savedPurchase,
          );
        }
        await manager.save(Purchase, savedPurchase);
      }

      return { purchase: savedPurchase, paymentMethod };
    });

    const createdPurchase = result.purchase;
    createdPurchase.paymentMethod = result.paymentMethod;
    await this.grantPurchaseRewardTokensForEvent(
      createdPurchase.customerId,
      createdPurchase.ticketQuantity,
      createdPurchase.uid,
      'created',
    );
    if (createdPurchase.status === PurchaseStatus.VERIFIED) {
      await this.grantPurchaseRewardTokensForEvent(
        createdPurchase.customerId,
        createdPurchase.ticketQuantity,
        createdPurchase.uid,
        'verified',
      );
    }
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

    const result = await this.dataSource.transaction(async (manager) => {
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

      // ── Blacklist Guard ──
      if (customer.isBlacklisted) {
        throw new ForbiddenException(
          'Este cliente se encuentra bloqueado y no puede realizar compras.',
        );
      }

      let screenshotKey = webhook.payment_screenshot;
      if (file) {
        screenshotKey = await this.uploadPaymentScreenshot(file, raffle.uid);
      }

      const totalAmount = Number(webhook.total_amount);
      const isVerified =
        (webhook.status as PurchaseStatus) === PurchaseStatus.VERIFIED;
      const currencySymbol = paymentMethod.currency?.symbol ?? '';

      // Build payments array from audit webhook flat fields
      const paymentsArray: PaymentEntry[] = [
        {
          amount: totalAmount,
          reference: webhook.bank_reference || '',
          currency: currencySymbol,
          evidenceUrl: screenshotKey || '',
          verified: isVerified,
          paymentMethodId: paymentMethod.uid,
          paymentMethodName: paymentMethod.name,
        },
      ];

      const purchase = manager.create(Purchase, {
        raffleId: raffle.uid,
        paymentMethodId: paymentMethod.uid,
        customerId: customer.uid,
        totalAmount,
        bankReference: webhook.bank_reference,
        ticketQuantity: Number(webhook.ticket_quantity),
        paymentScreenshotUrl: screenshotKey,
        status: (webhook.status as PurchaseStatus) || PurchaseStatus.PENDING,
        submittedAt: webhook.created_at
          ? new Date(webhook.created_at)
          : new Date(),
        verifiedAt: isVerified ? new Date() : null,
        payments: paymentsArray,
        totalPaid: totalAmount,
      });

      // If legacy system provided specific numbers, validate and assign
      if (webhook.ticket_numbers && Array.isArray(webhook.ticket_numbers)) {
        const numbers = webhook.ticket_numbers.map(Number);
        const lockedRaffle = await manager.findOne(Raffle, {
          where: { uid: raffle.uid },
          lock: { mode: 'pessimistic_write' },
        });
        await this.allocationService.validateSpecificSelection(
          manager,
          lockedRaffle,
          numbers,
          numbers.length,
        );
        purchase.ticketNumbers = numbers;
      }

      return {
        purchase: await manager.save(Purchase, purchase),
        paymentMethod,
      };
    });

    const createdPurchase = result.purchase;
    createdPurchase.paymentMethod = result.paymentMethod;
    await this.grantPurchaseRewardTokensForEvent(
      createdPurchase.customerId,
      createdPurchase.ticketQuantity,
      createdPurchase.uid,
      'created',
    );
    if (createdPurchase.status === PurchaseStatus.VERIFIED) {
      await this.grantPurchaseRewardTokensForEvent(
        createdPurchase.customerId,
        createdPurchase.ticketQuantity,
        createdPurchase.uid,
        'verified',
      );
    }
    await this.notifyPostPurchase(createdPurchase, 'created_audit');
    return createdPurchase;
  }

  /**
   * Handles the AI Lambda webhook response.
   * Validates Amount, Currency, and Reference against AI extraction.
   * Supports multi-payment: searches the payments[] JSONB array for matching references.
   */
  async processAiWebhook(webhook: AiWebhookDto) {
    const { purchaseId, aiResult } = webhook;

    this.logger.log(
      `[processAiWebhook] Inicio validación purchaseId=${purchaseId} hasAiResult=${Boolean(aiResult)}`,
    );

    const resultPurchase = await this.dataSource.transaction(
      async (manager) => {
        const verificationResult =
          await this.verificationService.processAiWebhook(
            manager,
            purchaseId,
            aiResult,
          );

        if (verificationResult.action === 'VERIFIED_NEW') {
          await this.allocationService.assignRandomNumbers(
            manager,
            verificationResult.purchase.raffleId,
            verificationResult.purchase,
          );
          await manager.save(Purchase, verificationResult.purchase);

          await this.spinsService.grantPurchaseRewardTokens({
            customerId: verificationResult.purchase.customerId,
            purchasedTickets: verificationResult.purchase.ticketQuantity,
            sourceReferenceBase: `purchase:${verificationResult.purchase.uid}:verified`,
            manager,
          });
        }

        return verificationResult.purchase;
      },
    );

    return this.serializePurchase(resultPurchase);
  }
  /**
   * Manual Status Update by Admin.
   * Triggers ticket assignment if status changes to VERIFIED.
   * Only SUPER_ADMIN can revert a purchase that is already VERIFIED.
   */
  async updateStatus(
    uid: string,
    updateDto: UpdatePurchaseStatusDto,
    adminRole: AdminRole,
    adminId: string,
  ) {
    const { status } = updateDto;
    const oldData = await this.findOne(uid);

    await this.dataSource.transaction(async (manager) => {
      const purchase = await manager.findOne(Purchase, { where: { uid } });
      if (!purchase) throw new NotFoundException('Purchase not found');

      // Business rule: VERIFIER, VERIFIER_EXPORT and VERIFIER_STATS can only verify, not reject
      const isVerifierLike =
        adminRole === AdminRole.VERIFIER ||
        adminRole === AdminRole.VERIFIER_EXPORT ||
        adminRole === AdminRole.VERIFIER_STATS;
      if (isVerifierLike && status === PurchaseStatus.REJECTED) {
        throw new ForbiddenException(
          'Verifiers cannot reject purchases. Only verification is allowed.',
        );
      }

      // Business rule: Only SUPER_ADMIN can revert a verified purchase
      if (
        purchase.status === PurchaseStatus.VERIFIED &&
        adminRole !== AdminRole.SUPER_ADMIN
      ) {
        throw new ForbiddenException(
          'Only Super Admin can revert a verified purchase',
        );
      }

      purchase.status = status;
      purchase.exportedToSheets = false;

      if (
        status === PurchaseStatus.REJECTED ||
        status === PurchaseStatus.DUPLICATED
      ) {
        purchase.ticketNumbers = null;
      }

      if (status === PurchaseStatus.VERIFIED) {
        purchase.verifiedAt = new Date();
        purchase.verificationSource = VerificationSource.ADMIN;
        purchase.auditReviewedAt = new Date();
        purchase.notes = null; // Notas limpias al verificar
        if (adminId) {
          purchase.verifiedByAdmin = { uid: adminId } as any;
        }
        // Assign ticket numbers for RANDOM raffles that don't have them yet
        if (!purchase.ticketNumbers || purchase.ticketNumbers.length === 0) {
          await this.allocationService.assignRandomNumbers(
            manager,
            purchase.raffleId,
            purchase,
          );
        }
        await this.spinsService.grantPurchaseRewardTokens({
          customerId: purchase.customerId,
          purchasedTickets: purchase.ticketQuantity,
          sourceReferenceBase: `purchase:${purchase.uid}:verified`,
          manager,
        });
      }
      await manager.save(Purchase, purchase);

      this.eventEmitter.emit('purchase.status_changed', {
        type: 'status_changed',
        msg: `Purchase status changed to ${status}`,
        raffleId: purchase.raffleId,
        purchaseId: purchase.uid,
        status,
      });
    });

    const newData = await this.findOne(uid);
    this.eventEmitter.emit('audit.log', {
      adminId,
      action: 'UPDATE',
      entityName: 'Purchase',
      entityId: uid,
      previousData: oldData,
      newData,
    } satisfies AuditEventPayload);
    return newData;
  }

  /**
   * Marks a purchase as audited (double-check by Admin on an AI-verified purchase).
   * Sets auditReviewedAt and optionally verifiedByAdmin if not already set.
   */
  async markAsAudited(uid: string, adminId: string) {
    const oldData = await this.findOne(uid);
    const purchase = await this.purchaseRepository.findOne({ where: { uid } });
    if (!purchase) throw new NotFoundException('Purchase not found');

    purchase.auditReviewedAt = new Date();
    purchase.exportedToSheets = false;
    if (!purchase.verifiedByAdmin) {
      purchase.verifiedByAdmin = { uid: adminId } as any;
    }
    await this.purchaseRepository.save(purchase);
    const newData = await this.findOne(uid);
    this.eventEmitter.emit('audit.log', {
      adminId,
      action: 'UPDATE',
      entityName: 'Purchase',
      entityId: uid,
      previousData: oldData,
      newData,
    } satisfies AuditEventPayload);
    return newData;
  }

  /**
   * Full update of a purchase.
   * Super Admin: all fields optional. Verifier: only notes.
   * Runs in a transaction. Validates raffle, payment method, customer, and ticket numbers when provided.
   */
  async update(
    uid: string,
    updateDto: UpdatePurchaseDto,
    file?: Express.Multer.File,
    adminId?: string,
    adminRole?: AdminRole,
  ) {
    const isVerifierLike =
      adminRole === AdminRole.VERIFIER ||
      adminRole === AdminRole.VERIFIER_EXPORT ||
      adminRole === AdminRole.VERIFIER_STATS;
    const effectiveDto: UpdatePurchaseDto = isVerifierLike
      ? { notes: updateDto.notes }
      : updateDto;
    const effectiveFile = isVerifierLike ? undefined : file;
    const oldData = await this.findOne(uid);

    await this.dataSource.transaction(async (manager) => {
      const purchase = await manager.findOne(Purchase, {
        where: { uid },
        relations: ['raffle', 'paymentMethod', 'customer'],
      });
      if (!purchase) throw new NotFoundException('Purchase not found');

      if (
        effectiveDto.raffleId !== undefined &&
        effectiveDto.raffleId !== purchase.raffleId
      ) {
        const raffle = await manager.findOne(Raffle, {
          where: { uid: effectiveDto.raffleId },
        });
        if (!raffle) throw new NotFoundException('Raffle not found');
        if (raffle.status !== RaffleStatus.ACTIVE) {
          throw new BadRequestException('Raffle is not active');
        }
        purchase.raffleId = effectiveDto.raffleId;
      }

      if (effectiveDto.paymentMethodId !== undefined) {
        const paymentMethod = await manager.findOne(PaymentMethod, {
          where: { uid: effectiveDto.paymentMethodId },
        });
        if (!paymentMethod) {
          throw new NotFoundException('Payment method not found');
        }
        purchase.paymentMethodId = effectiveDto.paymentMethodId;
        purchase.paymentMethod = paymentMethod;
      }

      if (effectiveDto.customer !== undefined) {
        const customer = await this.getOrCreateCustomer(
          manager,
          effectiveDto.customer,
        );
        purchase.customerId = customer.uid;
      } else if (effectiveDto.customerId !== undefined) {
        const customer = await manager.findOne(Customer, {
          where: { uid: effectiveDto.customerId },
        });
        if (!customer) throw new NotFoundException('Customer not found');
        purchase.customerId = effectiveDto.customerId;
      }

      const raffle =
        purchase.raffle ??
        (await manager.findOne(Raffle, { where: { uid: purchase.raffleId } }));

      if (effectiveDto.ticket_numbers !== undefined) {
        const numbers = effectiveDto.ticket_numbers;
        if (numbers.length === 0) {
          throw new BadRequestException(
            'ticket_numbers must contain at least one number',
          );
        }
        if (
          effectiveDto.ticket_quantity !== undefined &&
          numbers.length !== effectiveDto.ticket_quantity
        ) {
          throw new BadRequestException(
            `ticket_quantity (${effectiveDto.ticket_quantity}) must match ticket_numbers length (${numbers.length})`,
          );
        }
        if (!raffle) throw new NotFoundException('Raffle not found');
        // Acquire pessimistic write lock to prevent concurrent duplicate assignment
        const lockedRaffle = await manager.findOne(Raffle, {
          where: { uid: raffle.uid },
          lock: { mode: 'pessimistic_write' },
        });
        const uniqueNumbers = new Set(numbers);
        if (uniqueNumbers.size !== numbers.length) {
          throw new BadRequestException('ticket_numbers contains duplicates');
        }
        const invalid = numbers.filter(
          (n) => n < 0 || n >= lockedRaffle.totalTickets,
        );
        if (invalid.length > 0) {
          throw new BadRequestException(
            `Invalid ticket numbers (out of range): ${invalid.join(', ')}`,
          );
        }
        const occupiedCount = await this.allocationService.countOccupied(
          manager,
          lockedRaffle.uid,
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
      } else if (effectiveDto.ticket_quantity !== undefined) {
        const existingCount = purchase.ticketNumbers?.length ?? 0;
        if (
          existingCount > 0 &&
          effectiveDto.ticket_quantity !== existingCount
        ) {
          throw new BadRequestException(
            `ticket_quantity must match the number of assigned tickets (${existingCount})`,
          );
        }
        purchase.ticketQuantity = effectiveDto.ticket_quantity;
      }

      if (effectiveFile) {
        const key = await this.uploadPaymentScreenshot(
          effectiveFile,
          purchase.raffleId,
        );
        if (key) purchase.paymentScreenshotUrl = key;
      } else if (effectiveDto.payment_screenshot_url !== undefined) {
        purchase.paymentScreenshotUrl = effectiveDto.payment_screenshot_url;
      }

      if (effectiveDto.notes !== undefined) purchase.notes = effectiveDto.notes;
      if (effectiveDto.bank_reference !== undefined)
        purchase.bankReference = effectiveDto.bank_reference;
      if (effectiveDto.status !== undefined) {
        purchase.status = effectiveDto.status;
        if (effectiveDto.status === PurchaseStatus.VERIFIED) {
          if (!purchase.verifiedAt) {
            purchase.verifiedAt = new Date();
          }
          purchase.verificationSource = VerificationSource.ADMIN;
          purchase.auditReviewedAt = new Date();
          purchase.notes = null; // Notas limpias al verificar
          if (adminId) {
            purchase.verifiedByAdmin = { uid: adminId } as any;
          }
        } else if (
          effectiveDto.status === PurchaseStatus.REJECTED ||
          effectiveDto.status === PurchaseStatus.DUPLICATED
        ) {
          purchase.ticketNumbers = null;
        }
      }
      if (effectiveDto.totalAmount !== undefined)
        purchase.totalAmount = effectiveDto.totalAmount;

      if (effectiveDto.payments !== undefined) {
        purchase.payments = effectiveDto.payments.map((p) => ({
          amount: Number(p.amount),
          reference: p.reference ?? '',
          currency: p.currency ?? '',
          evidenceUrl: p.evidenceUrl ?? '',
          verified: p.verified ?? false,
          aiResult: p.aiResult,
          reviewedBy: p.reviewedBy,
          paymentMethodId: p.paymentMethodId ?? purchase.paymentMethodId,
          paymentMethodName: p.paymentMethodName,
          metadata: (p as any).metadata,
        }));
        purchase.totalPaid = purchase.payments.reduce(
          (sum, p) => sum + Number(p.amount),
          0,
        );
      }

      const ticketNumbersLength = purchase.ticketNumbers?.length;
      if (
        ticketNumbersLength != null &&
        purchase.ticketQuantity !== ticketNumbersLength
      ) {
        throw new BadRequestException(
          `ticket_quantity (${purchase.ticketQuantity}) must equal the number of assigned tickets (${ticketNumbersLength})`,
        );
      }

      purchase.exportedToSheets = false;
      await manager.save(Purchase, purchase);
    });

    const newData = await this.findOne(uid);
    this.eventEmitter.emit('audit.log', {
      adminId: adminId ?? null,
      action: 'UPDATE',
      entityName: 'Purchase',
      entityId: uid,
      previousData: oldData,
      newData,
    } satisfies AuditEventPayload);
    return newData;
  }

  async getRaffleOrdersSummary(
    raffleId: string,
  ): Promise<RaffleOrdersSummaryResponseDto> {
    if (!raffleId) {
      throw new BadRequestException('raffleId is required');
    }

    // 1. Obtener todas las currencies configuradas (para incluir las que no tengan órdenes)
    const currencies = await this.currencyRepository.find();

    if (!currencies.length) {
      return {
        raffleId,
        currencies: [],
        totals: {
          allCount: 0,
          pendingAndManualCount: 0,
          rejectedCount: 0,
        },
      };
    }

    // 2. Consulta agregada de órdenes por currency y estado
    const raw = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .leftJoin('purchase.paymentMethod', 'paymentMethod')
      .leftJoin('paymentMethod.currency', 'currency')
      .select('currency.uid', 'currencyUid')
      .addSelect('currency.name', 'currencyName')
      .addSelect('currency.symbol', 'currencySymbol')
      .addSelect('purchase.status', 'status')
      .addSelect('COUNT(purchase.uid)', 'count')
      .where('purchase.raffleId = :raffleId', { raffleId })
      .groupBy('currency.uid')
      .addGroupBy('currency.name')
      .addGroupBy('currency.symbol')
      .addGroupBy('purchase.status')
      .getRawMany<{
        currencyUid: string | null;
        currencyName: string | null;
        currencySymbol: string | null;
        status: PurchaseStatus;
        count: string;
      }>();

    // 3. Acumular por currencyUid y totales globales
    const perCurrencyMap = new Map<
      string,
      {
        pendingAndManualCount: number;
      }
    >();

    let allCount = 0;
    let pendingAndManualCountTotal = 0;
    let rejectedCount = 0;

    for (const row of raw) {
      const currencyUid = row.currencyUid;
      const status = row.status;
      const count = Number(row.count) || 0;

      // Totales globales por estado
      allCount += count;

      if (
        status === PurchaseStatus.PENDING ||
        status === PurchaseStatus.MANUAL_REVIEW
      ) {
        pendingAndManualCountTotal += count;
      }

      if (status === PurchaseStatus.REJECTED) {
        rejectedCount += count;
      }

      // Si la orden no tiene currency asociada, la contamos en totales globales
      // pero no en el breakdown por currency
      if (!currencyUid) continue;

      const current = perCurrencyMap.get(currencyUid) ?? {
        pendingAndManualCount: 0,
      };

      if (
        status === PurchaseStatus.PENDING ||
        status === PurchaseStatus.MANUAL_REVIEW
      ) {
        current.pendingAndManualCount += count;
      }

      perCurrencyMap.set(currencyUid, current);
    }

    // 4. Construir DTO de currencies garantizando incluir todas, incluso las que no tienen órdenes
    const currenciesDto: RaffleOrdersSummaryCurrencyDto[] = currencies.map(
      (currency) => {
        const stats = perCurrencyMap.get(currency.uid);
        return {
          currencyUid: currency.uid,
          name: currency.name,
          symbol: currency.symbol,
          pendingAndManualCount: stats?.pendingAndManualCount ?? 0,
        };
      },
    );

    const totals: RaffleOrdersSummaryTotalsDto = {
      allCount,
      pendingAndManualCount: pendingAndManualCountTotal,
      rejectedCount,
    };

    return {
      raffleId,
      currencies: currenciesDto,
      totals,
    };
  }

  async findAll(query: Record<string, unknown>, admin?: Admin) {
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
    const email = typeof query.email === 'string' ? query.email : undefined;
    const phone = typeof query.phone === 'string' ? query.phone : undefined;
    const dateFrom =
      typeof query.dateFrom === 'string' ? query.dateFrom : undefined;
    const dateTo = typeof query.dateTo === 'string' ? query.dateTo : undefined;
    const verificationSource =
      typeof query.verificationSource === 'string'
        ? query.verificationSource
        : undefined;
    const hasPromotionRaw = query.hasPromotion;
    const hasPromotion =
      hasPromotionRaw === 'true'
        ? true
        : hasPromotionRaw === 'false'
          ? false
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
      .leftJoinAndSelect('purchase.verifiedByAdmin', 'verifiedByAdmin')
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
    if (verificationSource) {
      qb.andWhere('purchase.verificationSource = :verificationSource', {
        verificationSource,
      });
    }
    if (hasPromotion === true) {
      qb.andWhere('purchase.promotion_snapshot IS NOT NULL');
    } else if (hasPromotion === false) {
      qb.andWhere('purchase.promotion_snapshot IS NULL');
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
      qb.andWhere('purchase.submittedAt >= :dateFrom', {
        dateFrom: dateFromStart,
      });
    }
    if (dateTo) {
      // Add one day to include the entire end date
      const dateToEnd = new Date(dateTo);
      dateToEnd.setHours(23, 59, 59, 999);
      qb.andWhere('purchase.submittedAt <= :dateTo', { dateTo: dateToEnd });
    }

    if (admin?.role === AdminRole.AUDITOR) {
      qb.andWhere('purchase.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [PurchaseStatus.REJECTED, PurchaseStatus.DUPLICATED],
      });
    }

    const [items, total] = await qb.getManyAndCount();

    const isAuditor = admin?.role === AdminRole.AUDITOR;

    const signedItems = await Promise.all(
      items.map(async (purchase) => {
        const {
          paymentScreenshotUrl: rawPaymentScreenshotUrl,
          payments: rawPayments = [],
          raffle: _raffle,
          paymentMethod: _paymentMethod,
          verifiedByAdmin: _verifiedByAdmin,
          submittedAt,
          verifiedAt,
          auditReviewedAt,
          ...purchaseRest
        } = purchase;

        const paymentsWithoutProof = rawPayments.map(
          ({ evidenceUrl: _evidenceUrl, ...payment }) => payment,
        );

        const customer =
          isAuditor && purchase.customer
            ? this.maskCustomerForAuditor(purchase.customer)
            : purchase.customer;

        const basePurchase = {
          ...purchaseRest,
          customer,
          paymentMethod: purchase.paymentMethod
            ? {
                uid: purchase.paymentMethod.uid,
                name: purchase.paymentMethod.name,
                accountHolderName: purchase.paymentMethod.accountHolderName,
              }
            : null,
          verifiedByAdmin: purchase.verifiedByAdmin
            ? {
                uid: purchase.verifiedByAdmin.uid,
                fullName: purchase.verifiedByAdmin.fullName,
              }
            : null,
          aiAnalysisResult: purchase?.aiAnalysisResult?.data ?? null,
        };

        if (isAuditor) {
          return {
            ...basePurchase,
            payments: paymentsWithoutProof,
            submittedAt: this.formatDateOnlyForAuditor(submittedAt),
            verifiedAt: this.formatDateOnlyForAuditor(verifiedAt),
            auditReviewedAt: this.formatDateOnlyForAuditor(auditReviewedAt),
          };
        }

        const paymentScreenshotUrl = await this.s3Service.getPresignedGetUrl(
          rawPaymentScreenshotUrl,
        );

        const paymentsWithCdn = await Promise.all(
          rawPayments.map(async (p) => ({
            ...p,
            evidenceUrl:
              (await this.s3Service.getPresignedGetUrl(p.evidenceUrl)) ??
              p.evidenceUrl,
          })),
        );

        return {
          ...basePurchase,
          paymentScreenshotUrl:
            paymentScreenshotUrl ?? rawPaymentScreenshotUrl,
          payments: paymentsWithCdn,
          submittedAt,
          verifiedAt,
          auditReviewedAt,
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

  async findOne(uid: string, admin?: Admin) {
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

    if (admin?.role === AdminRole.AUDITOR) {
      if (
        purchase.status === PurchaseStatus.REJECTED ||
        purchase.status === PurchaseStatus.DUPLICATED
      ) {
        throw new NotFoundException('Purchase not found');
      }
    }

    const [paymentScreenshotUrl, raffleImageUrl, paymentMethodImageUrl] =
      await Promise.all([
        this.s3Service.getPresignedGetUrl(purchase.paymentScreenshotUrl),
        this.s3Service.getPresignedGetUrl(purchase.raffle?.imageUrl),
        this.s3Service.getPresignedGetUrl(purchase.paymentMethod?.imageUrl),
      ]);

    const paymentsWithCdn = await Promise.all(
      (purchase.payments ?? []).map(async (p) => ({
        ...p,
        evidenceUrl:
          (await this.s3Service.getPresignedGetUrl(p.evidenceUrl)) ??
          p.evidenceUrl,
      })),
    );

    const redeemedCoupons = await this.couponsService.findByPurchaseId(uid);

    const { currency, ...paymentMethodRest } = purchase.paymentMethod || {};
    const customer =
      admin?.role === AdminRole.AUDITOR && purchase.customer
        ? this.maskCustomerForAuditor(purchase.customer)
        : purchase.customer;
    return {
      ...purchase,
      customer,
      ticketNumbers: purchase.ticketNumbers || [],
      paymentScreenshotUrl:
        paymentScreenshotUrl ?? purchase.paymentScreenshotUrl,
      payments: paymentsWithCdn,
      redeemedCoupons,
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
      aiAnalysisResult: purchase?.aiAnalysisResult?.data ?? null,
    };
  }

  /**
   * For AUDITOR role: returns only non-sensitive customer fields.
   */
  private maskCustomerForAuditor(
    customer: Customer | null,
  ): { uid: string; fullName: string; nationalId: string | null; phone: string | null } | null {
    if (!customer) return null;
    return {
      uid: customer.uid,
      fullName: customer.fullName,
      nationalId: this.maskDigitsPreservingEdges(customer.nationalId),
      phone: this.maskDigitsPreservingEdges(customer.phone),
    };
  }

  private maskDigitsPreservingEdges(
    value: string | null | undefined,
  ): string | null {
    const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
    if (!digits) return null;

    if (digits.length <= 4) {
      return '*'.repeat(digits.length);
    }

    const visibleDigits = 2;
    return `${digits.slice(0, visibleDigits)}${'*'.repeat(
      digits.length - visibleDigits * 2,
    )}${digits.slice(-visibleDigits)}`;
  }

  private formatDateOnlyForAuditor(
    date: Date | string | null | undefined,
  ): string | null {
    if (!date) return null;
    const parsedDate = typeof date === 'string' ? new Date(date) : date;

    return parsedDate.toLocaleDateString('es-VE', {
      timeZone: VENEZUELA_TIMEZONE,
    });
  }

  async remove(uid: string, adminId: string) {
    const oldData = await this.findOne(uid);
    const result = await this.purchaseRepository.delete(uid);
    if (result.affected === 0)
      throw new NotFoundException('Purchase not found');
    this.eventEmitter.emit('audit.log', {
      adminId,
      action: 'DELETE',
      entityName: 'Purchase',
      entityId: uid,
      previousData: oldData,
      newData: null,
    } satisfies AuditEventPayload);
  }

  /**
   * Uploads a payment evidence file to S3 and returns the key + presigned GET URL.
   */
  async uploadEvidence(
    file: Express.Multer.File,
  ): Promise<{ key: string; url: string }> {
    if (!file) {
      throw new BadRequestException('File is required');
    }
    const key = await this.uploadPaymentScreenshot(file, 'evidence');
    const url = (await this.s3Service.getPresignedGetUrl(key)) ?? key;
    return { key, url };
  }

  async generateReceiptsPdf(
    dto: ExportReceiptsDto,
    res: Response,
  ): Promise<void> {
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

    const purchases = await this.purchaseRepository.find({
      where: {
        paymentMethodId: dto.paymentMethodId,
        submittedAt: Between(startDate, endDate),
        status: In([
          PurchaseStatus.VERIFIED,
          PurchaseStatus.PENDING,
          PurchaseStatus.MANUAL_REVIEW,
        ]),
      },
      relations: ['customer', 'paymentMethod'],
      order: { submittedAt: 'ASC' },
    });

    const purchasesWithEvidence = purchases.filter((purchase) => {
      const hasLegacyEvidence = Boolean(
        purchase.paymentScreenshotUrl && purchase.paymentScreenshotUrl.trim(),
      );
      const hasPaymentsEvidence = (purchase.payments ?? []).some((entry) =>
        Boolean(entry.evidenceUrl && entry.evidenceUrl.trim()),
      );
      return hasLegacyEvidence || hasPaymentsEvidence;
    });

    if (!purchasesWithEvidence.length) {
      throw new NotFoundException(
        'No purchases with evidence found for the selected filters',
      );
    }

    const fileStart = startDate.toISOString().slice(0, 10);
    const fileEnd = endDate.toISOString().slice(0, 10);
    const filename = `receipts-${dto.paymentMethodId}-${fileStart}-${fileEnd}.pdf`;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });

    await this.exportService.generateReceiptsPdf(
      purchasesWithEvidence,
      res,
      filename,
    );
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
      // Siempre excluir compras rechazadas del export, sin importar los filtros
      .andWhere('purchase.status != :rejectedStatus', {
        rejectedStatus: PurchaseStatus.REJECTED,
      })
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
    if (currency) qb.andWhere('pmCurrency.symbol = :currency', { currency });
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
      qb.andWhere('purchase.submittedAt >= :dateFrom', {
        dateFrom: dateFromStart,
      });
    }
    if (dateTo) {
      // Add one day to include the entire end date
      const dateToEnd = new Date(dateTo);
      dateToEnd.setHours(23, 59, 59, 999);
      qb.andWhere('purchase.submittedAt <= :dateTo', { dateTo: dateToEnd });
    }

    const purchases = await qb.getMany();

    return this.exportService.generateExcel(
      purchases,
      paymentMethods,
      currency,
    );
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

    if (!raffle) throw new NotFoundException('Evento no encontrado');
    if (raffle.status !== RaffleStatus.ACTIVE)
      throw new BadRequestException(
        'Las compras para este evento no están disponibles en este momento',
      );

    return raffle;
  }

  /**
   * OTHER HELPERS (Customer, S3, Notifications)
   */

  private async getOrCreateCustomer(
    manager: EntityManager,
    data: any,
  ): Promise<Customer> {
    data = trimCustomerData(data);
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
      if (data.location !== undefined) {
        existingCustomer.location = data.location;
      }
      return await manager.save(Customer, existingCustomer);
    }

    const newCustomer = manager.create(Customer, {
      nationalId: normalizedNationalId,
      fullName: data.full_name || data.fullName,
      email: data.email,
      phone: data.phone,
      location: data.location,
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
    const relations = ['currency'];
    let pm = await manager.findOne(PaymentMethod, {
      where: { externalId: id },
      relations,
    });
    if (!pm && this.isUUID(id)) {
      pm = await manager.findOne(PaymentMethod, {
        where: { uid: id },
        relations,
      });
    }
    if (!pm && name) {
      pm = await manager.findOne(PaymentMethod, {
        where: { name: ILike(name) },
        relations,
      });
    }
    if (!pm) {
      throw new NotFoundException(`Payment method not found (ID: ${id})`);
    }
    return pm;
  }

  private async notifyPostPurchase(purchase: Purchase, eventType: string) {
    // If already verified (e.g. fully covered by coupons), skip SQS
    if (purchase.status === PurchaseStatus.VERIFIED) {
      this.eventEmitter.emit('purchase.status_changed', {
        type: 'verified',
        msg: 'Purchase auto-verified via coupons',
        raffleId: purchase.raffleId,
        purchaseId: purchase.uid,
        status: PurchaseStatus.VERIFIED,
      });
      return;
    }

    // 1. Send to SQS (only when payment method has AI verification enabled)
    if (purchase.paymentMethod?.aiVerificationEnabled !== false) {
      try {
        await this.sqsService.sendPurchaseCreatedMessage(purchase);
      } catch (err) {
        this.logger.error(
          'Failed to send purchase created message to SQS.',
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    // 2. Emit Real-time Event
    this.eventEmitter.emit('purchase.created', {
      type: eventType,
      msg: 'New purchase created',
      raffleId: purchase.raffleId,
      purchaseId: purchase.uid,
    });
  }

  private async grantPurchaseRewardTokensForEvent(
    customerId: string,
    ticketQuantity: number,
    purchaseId: string,
    eventKey: 'created' | 'verified',
  ): Promise<void> {
    await this.spinsService.grantPurchaseRewardTokens({
      customerId,
      purchasedTickets: ticketQuantity,
      sourceReferenceBase: `purchase:${purchaseId}:${eventKey}`,
    });
  }

  private isUUID(uuid: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      uuid,
    );
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
