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
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import axios from 'axios';
import { Response } from 'express';
import {
  Purchase,
  PurchaseStatus,
  VerificationSource,
  PaymentEntry,
} from './entities/purchase.entity';
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
import { ExportReceiptsDto } from './dto/export-receipts.dto';
import { S3Service } from '../../common/s3/s3.service';
import { SqsService } from '../../common/sqs/sqs.service';
import { AiWebhookDto } from './dto/ai-webhook.dto';
import { AuditWebhookDto } from './dto/audit-webhook.dto';
import { AdminRole } from '../auth/enums/admin-role.enum';
import { calculatePromotionalTotal } from '../raffles/utils/pricing.util';
import { formatDateVenezuela } from '../../common/utils/date.util';
import {
  RaffleOrdersSummaryCurrencyDto,
  RaffleOrdersSummaryResponseDto,
  RaffleOrdersSummaryTotalsDto,
} from './dto/purchases-summary.dto';

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
        bankReference: createDto.bank_reference || paymentsArray[0]?.reference || '',
        paymentScreenshotUrl: screenshotKey,
        customerId: customer.uid,
        status: PurchaseStatus.PENDING,
        ticketNumbers: ticketNumbers, // Saved immediately for SPECIFIC type
        payments: paymentsArray,
        totalPaid,
      });

      return { purchase: await manager.save(Purchase, purchase), paymentMethod };
    });

    const createdPurchase = result.purchase;
    createdPurchase.paymentMethod = result.paymentMethod;
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

      // If legacy system provided specific numbers, map them
      if (webhook.ticket_numbers && Array.isArray(webhook.ticket_numbers)) {
        purchase.ticketNumbers = webhook.ticket_numbers.map(Number);
      }

      // Note: If VERIFIED and no numbers provided, we might want to auto-assign here.
      // Logic left optional based on business requirements.

      return { purchase: await manager.save(Purchase, purchase), paymentMethod };
    });

    const createdPurchase = result.purchase;
    createdPurchase.paymentMethod = result.paymentMethod;
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

    return this.dataSource.transaction(async (manager) => {
      const purchase = await manager.findOne(Purchase, {
        where: { uid: purchaseId },
        relations: ['raffle', 'paymentMethod', 'paymentMethod.currency'],
        lock: { mode: 'pessimistic_write' },
      });
      if (!purchase) throw new NotFoundException('Purchase not found');

      const wasVerified = purchase.status === PurchaseStatus.VERIFIED;

      // 1. Guardamos el resultado crudo para auditoría futura
      purchase.aiAnalysisResult = aiResult ?? null;

      // Webhooks duplicados/tardíos no deben degradar una compra ya verificada
      if (wasVerified) {
        const saved = await manager.save(Purchase, purchase);
        return this.serializePurchase(saved);
      }

      // Definimos la interfaz que coincide con tu OCR Service nuevo
      interface AiAnalysisResponse {
        isValidReceipt?: boolean;
        isGenuineReceipt?: boolean | null;
        documentType?: string;
        fraudReason: string | null;
        confidence?: number;
        fraudIndicators?: string[] | null;
        amount?: number | null;
        reference?: string | null;
        data?: {
          amount?: number | null;
          reference?: string | null;
          currency?: string | null;
          date?: string | null;
        };
      }

      if (!aiResult || typeof aiResult !== 'object') {
        return this.handleManualReview(
          manager,
          purchase,
          'IA: Payload inválido (sin objeto aiResult)',
        );
      }

      // Normalizamos para soportar payload nuevo (data.*) y legacy (campos flat)
      const aiData = aiResult as AiAnalysisResponse;
      const extractedAmount = aiData.data?.amount ?? aiData.amount ?? null;
      const extractedRef = aiData.data?.reference ?? aiData.reference ?? null;
      const aiIsValidReceipt =
        typeof aiData.isValidReceipt === 'boolean'
          ? aiData.isValidReceipt
          : aiData.isGenuineReceipt === true
            ? true
            : aiData.isGenuineReceipt === false
              ? false
              : undefined;
      const aiFraudReason =
        aiData.fraudReason ??
        (Array.isArray(aiData.fraudIndicators) && aiData.fraudIndicators.length > 0
          ? aiData.fraudIndicators.join(' | ')
          : null);
      const aiDocumentType = aiData.documentType ?? 'UNKNOWN';

      // =================================================================
      // FASE 1: DETECCIÓN DE FRAUDE (Bloqueo Inmediato)
      // =================================================================

      // Si el OCR dice que NO es un recibo válido (ej: es un formulario o chat)
      if (aiIsValidReceipt === false) {
        return this.handleManualReview(
          manager,
          purchase,
          `[FRAUDE DETECTADO] Documento inválido: ${aiFraudReason || 'No es un comprobante bancario final'} (${aiDocumentType})`,
        );
      }

      // =================================================================
      // FASE 2: VALIDACIÓN DE DATOS BÁSICOS
      // =================================================================

      if (extractedAmount === null || extractedAmount === undefined || !extractedRef) {
        return this.handleManualReview(
          manager,
          purchase,
          'IA: Datos insuficientes (No se pudo leer monto o referencia)',
        );
      }

      // =================================================================
      // FASE 3: CHEQUEO DE DUPLICADOS (Match Difuso)
      // =================================================================
      const normalizedAiRef = this.normalizeReference(extractedRef);

      if (!normalizedAiRef) {
        return this.handleManualReview(manager, purchase, 'IA: Referencia vacía tras normalización');
      }

      // Buscamos si esta referencia YA EXISTE en otra compra (evitar doble canje)
      const existingWithRef = await manager
        .getRepository(Purchase)
        .createQueryBuilder('p')
        .where('p.uid != :uid', { uid: purchaseId }) // Excluir la compra actual
        .andWhere(
          new Brackets((qb) => {
            // A. Coincidencia en la referencia principal (Legacy)
            qb.where("REGEXP_REPLACE(UPPER(p.bank_reference), '[^A-Z0-9]', '', 'g') = :ref", { ref: normalizedAiRef })
            // B. Coincidencia en el resultado de IA previo
              .orWhere("p.ai_analysis_result->'data'->>'reference' IS NOT NULL AND REGEXP_REPLACE(UPPER(p.ai_analysis_result->'data'->>'reference'), '[^A-Z0-9]', '', 'g') = :ref", { ref: normalizedAiRef })
            // C. Coincidencia dentro del array de pagos (Abonos)
              .orWhere(`EXISTS (
                  SELECT 1 FROM jsonb_array_elements(p.payments) AS elem
                  WHERE REGEXP_REPLACE(UPPER(elem->>'reference'), '[^A-Z0-9]', '', 'g') = :ref
                )`, { ref: normalizedAiRef });
          }),
        )
        .getOne();

      if (existingWithRef) {
        purchase.status = PurchaseStatus.DUPLICATED;
        purchase.exportedToSheets = false;
        const saved = await manager.save(Purchase, purchase);
        this.emitStatusChange(saved, 'duplicated', `Referencia duplicada con compra ${existingWithRef.uid}`);
        return this.serializePurchase(saved);
      }

      // =================================================================
      // FASE 4: VINCULACIÓN CON EL PAGO (Abonos)
      // =================================================================

      const paymentsArray: PaymentEntry[] = purchase.payments ?? [];
      let matchedPaymentIndex = -1;

      // Buscamos a cuál de los pagos reportados por el usuario corresponde esta foto
      if (paymentsArray.length > 0) {
        for (let i = 0; i < paymentsArray.length; i++) {
          const entry = paymentsArray[i];
          if (entry.verified) continue; // Saltamos los que ya están listos

          const normalizedEntryRef = this.normalizeReference(entry.reference);
          // Usamos coincidencia difusa (ej: termina en...)
          if (normalizedEntryRef && this.isReferenceMatch(normalizedEntryRef, normalizedAiRef)) {
            matchedPaymentIndex = i;
            break;
          }
        }
      }

      // Si no encontramos match en el array, probamos con la referencia legacy
      const normalizedUserRef = this.normalizeReference(purchase.bankReference);
      const legacyRefMatch = normalizedUserRef ? this.isReferenceMatch(normalizedUserRef, normalizedAiRef) : false;

      if (matchedPaymentIndex === -1 && !legacyRefMatch) {
        return this.handleManualReview(
          manager,
          purchase,
          `IA: Referencia no coincide. Usuario dijo: "${normalizedUserRef || 'N/A'}", Foto dice: "${normalizedAiRef}"`
        );
      }

      // =================================================================
      // FASE 5: VALIDACIÓN DE MONTO
      // =================================================================
      let isAmountValid: boolean;
      let targetAmount = 0;

      if (matchedPaymentIndex >= 0) {
        // Validamos contra el abono específico
        targetAmount = Number(paymentsArray[matchedPaymentIndex].amount);
        isAmountValid = Math.abs(targetAmount - extractedAmount) < 1.00; // Tolerancia de 1.00 por decimales
      } else {
        // Legacy: Validamos contra el total
        targetAmount = Number(purchase.totalAmount);
        isAmountValid = Math.abs(targetAmount - extractedAmount) < 1.00;
      }

      if (!isAmountValid) {
        return this.handleManualReview(
          manager,
          purchase,
          `IA: Monto incorrecto. Esperado: ${targetAmount}, Foto dice: ${extractedAmount}`
        );
      }

      // =================================================================
      // FASE 6: APROBACIÓN Y ACTUALIZACIÓN
      // =================================================================

      // Actualizamos el array de pagos
      if (matchedPaymentIndex >= 0) {
        paymentsArray[matchedPaymentIndex].verified = true;
        paymentsArray[matchedPaymentIndex].aiResult = aiResult; // Guardamos evidencia en el item
        purchase.payments = [...paymentsArray]; // Forzamos update de TypeORM
      } else {
        // Fallback legacy: si no hay array, creamos un registro mínimo verificable
        if (paymentsArray.length > 0) {
          paymentsArray[0].verified = true;
          paymentsArray[0].aiResult = aiResult;
          purchase.payments = [...paymentsArray];
        } else {
          const inferredPayment: PaymentEntry = {
            amount: Number(purchase.totalAmount),
            reference: purchase.bankReference || extractedRef,
            currency: purchase.paymentMethod?.currency?.symbol ?? '',
            evidenceUrl: purchase.paymentScreenshotUrl ?? '',
            verified: true,
            aiResult,
            paymentMethodId: purchase.paymentMethodId,
            paymentMethodName: purchase.paymentMethod?.name,
          };
          purchase.payments = [inferredPayment];
        }
      }

      // Recalcular Total Pagado Real
      const newTotalPaid = (purchase.payments ?? [])
        .filter((p) => p.verified)
        .reduce((sum, p) => sum + Number(p.amount), 0);

      purchase.totalPaid = Number(newTotalPaid.toFixed(2));

      // ¿Ya pagó todo?
      if (purchase.totalPaid >= Number(purchase.totalAmount)) {
        purchase.status = PurchaseStatus.VERIFIED;
        purchase.verifiedAt = new Date();
        purchase.verificationSource = VerificationSource.AI;
        purchase.verifiedByAdmin = null; // Limpiamos si antes lo vio un admin
      } else {
        // Aún falta plata (Abono parcial verificado)
        // Podríamos poner un status PARTIAL_PAYMENT si existiera, o dejar PENDING
      }

      // Si pasó a VERIFICADO, asignamos tickets
      if (purchase.status === PurchaseStatus.VERIFIED && !wasVerified) {
        purchase.exportedToSheets = false;
        const saved = await manager.save(Purchase, purchase);
        this.emitStatusChange(saved, 'verified', 'Verificado por IA exitosamente');
        await this.assignTickets(manager, saved);
        return this.serializePurchase(saved);
      }

      // Guardado final (para casos de abono parcial o actualizaciones menores)
      purchase.exportedToSheets = false;
      const updatedPurchase = await manager.save(Purchase, purchase);
      return this.serializePurchase(updatedPurchase);
    });
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

    return this.dataSource.transaction(async (manager) => {
      const purchase = await manager.findOne(Purchase, { where: { uid } });
      if (!purchase) throw new NotFoundException('Purchase not found');

      // Business rule: VERIFIER and VERIFIER_EXPORT can only verify, not reject
      const isVerifierLike = adminRole === AdminRole.VERIFIER || adminRole === AdminRole.VERIFIER_EXPORT;
      if (isVerifierLike && status === PurchaseStatus.REJECTED) {
        throw new ForbiddenException('Verifiers cannot reject purchases. Only verification is allowed.');
      }

      // Business rule: Only SUPER_ADMIN can revert a verified purchase
      if (purchase.status === PurchaseStatus.VERIFIED && adminRole !== AdminRole.SUPER_ADMIN) {
        throw new ForbiddenException('Only Super Admin can revert a verified purchase');
      }

      purchase.status = status;
      purchase.exportedToSheets = false;

      if (status === PurchaseStatus.VERIFIED) {
        purchase.verifiedAt = new Date();
        purchase.verificationSource = VerificationSource.ADMIN;
        purchase.auditReviewedAt = new Date();
        if (adminId) {
          purchase.verifiedByAdmin = { uid: adminId } as any;
        }
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
   * Marks a purchase as audited (double-check by Admin on an AI-verified purchase).
   * Sets auditReviewedAt and optionally verifiedByAdmin if not already set.
   */
  async markAsAudited(uid: string, adminId: string) {
    const purchase = await this.purchaseRepository.findOne({ where: { uid } });
    if (!purchase) throw new NotFoundException('Purchase not found');

    purchase.auditReviewedAt = new Date();
    purchase.exportedToSheets = false;
    if (!purchase.verifiedByAdmin) {
      purchase.verifiedByAdmin = { uid: adminId } as any;
    }
    await this.purchaseRepository.save(purchase);
    return this.findOne(uid);
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
    const isVerifierLike = adminRole === AdminRole.VERIFIER || adminRole === AdminRole.VERIFIER_EXPORT;
    const effectiveDto: UpdatePurchaseDto =
      isVerifierLike ? { notes: updateDto.notes } : updateDto;
    const effectiveFile = isVerifierLike ? undefined : file;

    await this.dataSource.transaction(async (manager) => {
      const purchase = await manager.findOne(Purchase, {
        where: { uid },
        relations: ['raffle', 'paymentMethod', 'customer'],
      });
      if (!purchase) throw new NotFoundException('Purchase not found');

      if (effectiveDto.raffleId !== undefined) {
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
      }

      if (effectiveDto.customer !== undefined) {
        const customer = await this.getOrCreateCustomer(manager, effectiveDto.customer);
        purchase.customerId = customer.uid;
      } else if (effectiveDto.customerId !== undefined) {
        const customer = await manager.findOne(Customer, {
          where: { uid: effectiveDto.customerId },
        });
        if (!customer) throw new NotFoundException('Customer not found');
        purchase.customerId = effectiveDto.customerId;
      }

      const raffle = purchase.raffle ?? (await manager.findOne(Raffle, { where: { uid: purchase.raffleId } }));

      if (effectiveDto.ticket_numbers !== undefined) {
        const numbers = effectiveDto.ticket_numbers;
        if (numbers.length === 0) {
          throw new BadRequestException('ticket_numbers must contain at least one number');
        }
        if (effectiveDto.ticket_quantity !== undefined && numbers.length !== effectiveDto.ticket_quantity) {
          throw new BadRequestException(
            `ticket_quantity (${effectiveDto.ticket_quantity}) must match ticket_numbers length (${numbers.length})`,
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
      } else if (effectiveDto.ticket_quantity !== undefined) {
        const existingCount = purchase.ticketNumbers?.length ?? 0;
        if (existingCount > 0 && effectiveDto.ticket_quantity !== existingCount) {
          throw new BadRequestException(
            `ticket_quantity must match the number of assigned tickets (${existingCount})`,
          );
        }
        purchase.ticketQuantity = effectiveDto.ticket_quantity;
      }

      if (effectiveFile) {
        const key = await this.uploadPaymentScreenshot(effectiveFile, purchase.raffleId);
        if (key) purchase.paymentScreenshotUrl = key;
      } else if (effectiveDto.payment_screenshot_url !== undefined) {
        purchase.paymentScreenshotUrl = effectiveDto.payment_screenshot_url;
      }

      if (effectiveDto.notes !== undefined) purchase.notes = effectiveDto.notes;
      if (effectiveDto.bank_reference !== undefined) purchase.bankReference = effectiveDto.bank_reference;
      if (effectiveDto.status !== undefined) {
        purchase.status = effectiveDto.status;
        if (effectiveDto.status === PurchaseStatus.VERIFIED) {
          if (!purchase.verifiedAt) {
            purchase.verifiedAt = new Date();
          }
          purchase.verificationSource = VerificationSource.ADMIN;
          purchase.auditReviewedAt = new Date();
          if (adminId) {
            purchase.verifiedByAdmin = { uid: adminId } as any;
          }
        }
      }
      if (effectiveDto.totalAmount !== undefined) purchase.totalAmount = effectiveDto.totalAmount;

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
        }));
        purchase.totalPaid = purchase.payments.reduce(
          (sum, p) => sum + Number(p.amount),
          0,
        );
      }

      const ticketNumbersLength = purchase.ticketNumbers?.length;
      if (ticketNumbersLength != null && purchase.ticketQuantity !== ticketNumbersLength) {
        throw new BadRequestException(
          `ticket_quantity (${purchase.ticketQuantity}) must equal the number of assigned tickets (${ticketNumbersLength})`,
        );
      }

      purchase.exportedToSheets = false;
      await manager.save(Purchase, purchase);
    });

    return this.findOne(uid);
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
    const verificationSource =
      typeof query.verificationSource === 'string' ? query.verificationSource : undefined;

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
      qb.andWhere('purchase.verificationSource = :verificationSource', { verificationSource });
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

      const paymentsWithCdn = (purchase.payments ?? []).map((p) => ({
        ...p,
        evidenceUrl: this.s3Service.getCdnUrl(p.evidenceUrl) ?? p.evidenceUrl,
      }));

      const { currency, ...paymentMethodRest } =
        purchase.paymentMethod || {};
      return {
        ...purchase,
        paymentScreenshotUrl:
          paymentScreenshotUrl ?? purchase.paymentScreenshotUrl,
        payments: paymentsWithCdn,
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
        verifiedByAdmin: purchase.verifiedByAdmin
          ? {
              uid: purchase.verifiedByAdmin.uid,
              fullName: purchase.verifiedByAdmin.fullName,
            }
          : null,
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

    const paymentsWithCdn = (purchase.payments ?? []).map((p) => ({
      ...p,
      evidenceUrl: this.s3Service.getCdnUrl(p.evidenceUrl) ?? p.evidenceUrl,
    }));

    const { currency, ...paymentMethodRest } = purchase.paymentMethod || {};
    return {
      ...purchase,
      ticketNumbers: purchase.ticketNumbers || [],
      paymentScreenshotUrl:
        paymentScreenshotUrl ?? purchase.paymentScreenshotUrl,
      payments: paymentsWithCdn,
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

  /**
   * Uploads a payment evidence file to S3 and returns the key + CDN URL.
   */
  async uploadEvidence(
    file: Express.Multer.File,
  ): Promise<{ key: string; url: string }> {
    if (!file) {
      throw new BadRequestException('File is required');
    }
    const key = await this.uploadPaymentScreenshot(file, 'evidence');
    const url = this.s3Service.getCdnUrl(key);
    return { key, url: url || key };
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

    const doc = new PDFDocument({
      margin: 50,
      size: 'A4',
    });
    doc.pipe(res);

    for (let index = 0; index < purchasesWithEvidence.length; index++) {
      const purchase = purchasesWithEvidence[index];
      if (index > 0) {
        doc.addPage();
      }

      const evidenceKey =
        (purchase.payments ?? []).find((entry) => entry.evidenceUrl?.trim())
          ?.evidenceUrl ??
        purchase.paymentScreenshotUrl;
      const evidenceUrl = this.s3Service.getCdnUrl(evidenceKey) ?? evidenceKey;

      doc
        .fontSize(16)
        .text(`Comprobante ${index + 1}`, { underline: true })
        .moveDown(0.7);
      doc
        .fontSize(11)
        .fillColor('black')
        .text(`Fecha: ${formatDateVenezuela(purchase.submittedAt)}`)
        .text(`Cliente: ${purchase.customer?.fullName || '-'}`)
        .text(`Cédula: ${purchase.customer?.nationalId || '-'}`)
        .text(`Referencia: ${purchase.bankReference || '-'}`)
        .text(`Monto: ${Number(purchase.totalAmount || 0).toFixed(2)}`)
        .moveDown();

      if (!evidenceUrl) {
        doc
          .fillColor('red')
          .fontSize(12)
          .text('Error cargando imagen: evidencia no disponible')
          .fillColor('black');
        continue;
      }

      try {
        const response = await axios.get<ArrayBuffer>(evidenceUrl, {
          responseType: 'arraybuffer',
          timeout: 15000,
        });
        const imageBuffer = Buffer.from(response.data);
        doc.image(imageBuffer, {
          fit: [500, 500],
          align: 'center',
          valign: 'center',
        });
      } catch (error) {
        this.logger.warn(
          `Failed to load evidence image for purchase ${purchase.uid}: ${error instanceof Error ? error.message : String(error)}`,
        );
        doc
          .fillColor('red')
          .fontSize(12)
          .text('Error cargando imagen')
          .fillColor('black');
      }
    }

    doc.end();
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
        { header: 'Vendedor', key: 'seller', width: 20 },
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
        const isDuplicated = p.status === PurchaseStatus.DUPLICATED;
        worksheet.addRow({
          date: formatDateVenezuela(p.submittedAt),
          customer: p.customer?.fullName || '-',
          nationalId: p.customer?.nationalId || '-',
          email: p.customer?.email || '-',
          phone: p.customer?.phone || '-',
          ticketQty: p.ticketQuantity,
          amount: isDuplicated
            ? '0,00'
            : Number(p.totalAmount).toFixed(2).replace('.', ','),
          reference: p.bankReference || '-',
          status: statusLabels[p.status] || p.status,
          seller: p.paymentMethod?.accountHolderName || '-',
          raffle: p.raffle?.title || '-',
        });
      });

      const pmTotal = pmPurchases.reduce(
        (sum, p) =>
          sum +
          (p.status === PurchaseStatus.DUPLICATED ? 0 : Number(p.totalAmount)),
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
        ticketQty: pmPurchases.reduce(
          (sum, p) =>
            sum +
            (p.status === PurchaseStatus.DUPLICATED ? 0 : p.ticketQuantity),
          0,
        ),
        amount: pmTotal.toFixed(2).replace('.', ','),
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
      total: grandTotal.toFixed(2).replace('.', ','),
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
   * - NFKC: convierte fullwidth (ej. OCR) y variantes Unicode a ASCII
   * - Convierte a mayúsculas
   * - Elimina todo lo que no sea letra ni dígito (espacios, guiones, etc.)
   */
  private normalizeReference(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const str = String(raw);
    const normalized = str.normalize('NFKC');
    const upper = normalized.toUpperCase();
    const cleaned = upper.replace(/[^A-Z0-9]/g, '');
    return cleaned || null;
  }

  /**
   * Checks if two normalized references match using endsWith or contains logic.
   * Both refs must already be normalized (uppercase, alphanumeric only).
   */
  private isReferenceMatch(
    normalizedRefA: string,
    normalizedRefB: string,
  ): boolean {
    if (!normalizedRefA || !normalizedRefB) return false;

    // endsWith match
    const endsWithMatch =
      normalizedRefA.endsWith(normalizedRefB) ||
      normalizedRefB.endsWith(normalizedRefA);

    // contains match (shorter ref must be at least 4 chars)
    const containsMatch =
      normalizedRefA.includes(normalizedRefB) ||
      normalizedRefB.includes(normalizedRefA);

    const minLengthForContains = 4;
    const shorterRef =
      normalizedRefA.length <= normalizedRefB.length
        ? normalizedRefA
        : normalizedRefB;
    const longerRef =
      normalizedRefA.length > normalizedRefB.length
        ? normalizedRefA
        : normalizedRefB;

    return (
      endsWithMatch ||
      (containsMatch &&
        shorterRef.length >= minLengthForContains &&
        longerRef.includes(shorterRef))
    );
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
    let pm = await manager.findOne(PaymentMethod, { where: { externalId: id }, relations });
    if (!pm && this.isUUID(id)) {
      pm = await manager.findOne(PaymentMethod, { where: { uid: id }, relations });
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
    purchase.exportedToSheets = false;
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