import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository, ILike } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as ExcelJS from 'exceljs';
import { Purchase, PurchaseStatus } from './entities/purchase.entity';
import { Ticket } from 'src/modules/tickets/entities/ticket.entity';
import { Customer } from 'src/modules/customers/entities/customer.entity';
import { Raffle } from 'src/modules/raffles/entities/raffle.entity';
import { PaymentMethod } from 'src/modules/payments/entities/payment-method.entity';
import { Currency } from 'src/modules/currencies/entities/currency.entity';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { UpdatePurchaseStatusDto } from './dto/update-purchase-status.dto';
import { ExportPurchasesDto } from './dto/export-purchases.dto';
import { S3Service } from '../../common/s3/s3.service';
import { SqsService } from '../../common/sqs/sqs.service';
import { AiWebhookDto } from './dto/ai-webhook.dto';
import { AuditWebhookDto } from './dto/audit-webhook.dto';

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

  async create(createDto: CreatePurchaseDto, file: Express.Multer.File | undefined) {
    const createdPurchase = await this.dataSource.transaction(async (manager) => {
      // 1. Reusable Customer Logic
      const customer = await this.getOrCreateCustomer(manager, {
        nationalId: createDto.customer.national_id,
        fullName: createDto.customer.full_name,
        email: createDto.customer.email,
        phone: createDto.customer.phone,
      });

      // 2. Reusable S3 Logic
      const screenshotKey = await this.uploadPaymentScreenshot(file, createDto.raffleId);

      // 3. Create Purchase
      const purchase = manager.create(Purchase, {
        raffleId: createDto.raffleId,
        paymentMethodId: createDto.paymentMethodId,
        ticketQuantity: createDto.ticket_quantity,
        totalAmount: createDto.totalAmount,
        bankReference: createDto.bank_reference,
        paymentScreenshotUrl: screenshotKey, // Using 'Url' field name but storing Key
        customerId: customer.uid,
        status: PurchaseStatus.PENDING,
      });

      return await manager.save(Purchase, purchase);
    });

    // 4. Reusable Notification Logic (SQS + Events)
    await this.notifyPostPurchase(createdPurchase, 'created');

    return createdPurchase;
  }

  async processAuditWebhook(webhook: AuditWebhookDto, file: Express.Multer.File | undefined) {
    // Audit validation: File or URL is required
    if (!file && !webhook.payment_screenshot) {
      throw new BadRequestException('Payment screenshot (file or URL) is required');
    }

    const createdPurchase = await this.dataSource.transaction(async (manager) => {
      // A. Resolve External Dependencies
      const raffle = await this.resolveRaffle(manager, webhook.raffle_id);
      const paymentMethod = await this.resolvePaymentMethod(
        manager,
        webhook.payment_method_id,
        webhook.payment_method_name,
      );

      // B. Reusable Customer Logic
      const customer = await this.getOrCreateCustomer(manager, {
        nationalId: webhook.national_id,
        fullName: webhook.full_name,
        email: webhook.email,
        phone: webhook.phone,
      });

      // C. Reusable S3 Logic (or use provided URL)
      let screenshotKey = webhook.payment_screenshot;
      if (file) {
        screenshotKey = await this.uploadPaymentScreenshot(file, raffle.uid);
      }

      // D. Create Purchase
      const purchase = manager.create(Purchase, {
        raffleId: raffle.uid,
        paymentMethodId: paymentMethod.uid,
        customerId: customer.uid,
        totalAmount: Number(webhook.total_amount),
        bankReference: webhook.bank_reference,
        ticketQuantity: Number(webhook.ticket_quantity),
        paymentScreenshotUrl: screenshotKey,
        // If audited system sends specific status, use it, else default to VERIFIED for audits
        status: (webhook.status as PurchaseStatus) || PurchaseStatus.VERIFIED,
        // Use original creation date if provided
        submittedAt: webhook.created_at ? new Date(webhook.created_at) : new Date(),
        verifiedAt: webhook.status === PurchaseStatus.VERIFIED ? new Date() : null,
      });

      // E. Handle Tickets for Audit
      // If the webhook provides specific ticket numbers (from legacy system)
      if (webhook.ticket_numbers && Array.isArray(webhook.ticket_numbers)) {
         purchase.ticketNumbers = webhook.ticket_numbers.map(Number);
      }
      // If no specific numbers provided, but it's VERIFIED, we might want to assign them now
      // Uncomment the next line if you want auto-assignment for legacy verified purchases without numbers
      // else if (purchase.status === PurchaseStatus.VERIFIED) { await this.assignTickets(manager, purchase); }

      return await manager.save(Purchase, purchase);
    });

    // F. Reusable Notification Logic (SQS + Events)
    await this.notifyPostPurchase(createdPurchase, 'created_audit');

    return createdPurchase;
  }

  async updateStatus(uid: string, updateDto: UpdatePurchaseStatusDto) {
    const { status } = updateDto;

    return this.dataSource.transaction(async (manager) => {
      const purchase = await manager.findOne(Purchase, { where: { uid } });
      if (!purchase) throw new NotFoundException('Purchase not found');

      const wasVerified = purchase.status === PurchaseStatus.VERIFIED;
      if (wasVerified) throw new BadRequestException('Purchase has already been verified.');

      purchase.status = status;

      if (status === PurchaseStatus.VERIFIED) {
        purchase.verifiedAt = new Date();
        await this.assignTickets(manager, purchase);
      } else {
        await manager.save(Purchase, purchase);
      }

      // Emit event for real-time dashboard updates
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

  // ... (findAll, findOne, remove, exportPurchases methods remain unchanged) ...
  // ... Copia aquí tus métodos findAll, findOne, remove, exportPurchases que ya tenías ...

  async findAll(query: Record<string, unknown>) {
      // ... (Tu implementación actual) ...
      // Para no alargar la respuesta, asumo que mantienes este código igual
      // Si quieres que lo incluya completo, avísame.
       const raffleId =
      typeof query.raffleId === 'string' ? query.raffleId : undefined;
    const status = typeof query.status === 'string' ? query.status : undefined;
    const nationalId =
      typeof query.nationalId === 'string' ? query.nationalId : undefined;
    const currency =
      typeof query.currency === 'string' ? query.currency : undefined;
    const paymentMethodId =
      typeof query.paymentMethodId === 'string' ? query.paymentMethodId : undefined;
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
    if (paymentMethodId) {
      qb.andWhere('purchase.paymentMethodId = :paymentMethodId', { paymentMethodId });
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

  // ... findOne, exportPurchases, remove ...
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

  async exportPurchases(filters: ExportPurchasesDto): Promise<Buffer> {
      // ... Tu lógica actual de exportación ...
       const { raffleId, currency, status, nationalId, paymentMethodId, ticketNumber } = filters;

    // 1. Get all payment methods for the requested currency
    const paymentMethodsQb = this.paymentMethodRepository
      .createQueryBuilder('pm')
      .leftJoinAndSelect('pm.currency', 'currency');

    if (currency) {
      paymentMethodsQb.andWhere('currency.symbol = :currency', { currency });
    }

    const paymentMethods = await paymentMethodsQb.getMany();

    // 2. Query all purchases matching filters (no pagination)
    const qb = this.purchaseRepository
      .createQueryBuilder('purchase')
      .leftJoinAndSelect('purchase.customer', 'customer')
      .leftJoinAndSelect('purchase.raffle', 'raffle')
      .leftJoinAndSelect('purchase.paymentMethod', 'paymentMethod')
      .leftJoinAndSelect('paymentMethod.currency', 'pmCurrency')
      .orderBy('purchase.submittedAt', 'DESC');

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
      qb.andWhere('pmCurrency.symbol = :currency', { currency });
    }
    if (paymentMethodId) {
      qb.andWhere('purchase.paymentMethodId = :paymentMethodId', { paymentMethodId });
    }
    if (ticketNumber !== undefined && !Number.isNaN(ticketNumber)) {
      qb.andWhere(':ticketNumber = ANY(purchase.ticketNumbers)', { ticketNumber });
    }

    const purchases = await qb.getMany();

    // 4. Group purchases by payment method
    const purchasesByPaymentMethod = new Map<string, Purchase[]>();
    for (const pm of paymentMethods) {
      purchasesByPaymentMethod.set(pm.uid, []);
    }
    for (const purchase of purchases) {
      const pmId = purchase.paymentMethodId;
      if (purchasesByPaymentMethod.has(pmId)) {
        purchasesByPaymentMethod.get(pmId)!.push(purchase);
      }
    }

    // 5. Create Excel workbook
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

    // Helper to add headers to a worksheet
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

      // Style header row
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' },
      };
    };

    // Helper to add purchase rows
    const addPurchaseRows = (worksheet: ExcelJS.Worksheet, purchases: Purchase[]) => {
      for (const purchase of purchases) {
        worksheet.addRow({
          date: new Date(purchase.submittedAt).toLocaleString('es-VE'),
          customer: purchase.customer?.fullName || '-',
          nationalId: purchase.customer?.nationalId || '-',
          email: purchase.customer?.email || '-',
          phone: purchase.customer?.phone || '-',
          ticketQty: purchase.ticketQuantity,
          amount: Number(purchase.totalAmount).toFixed(2),
          reference: purchase.bankReference || '-',
          status: statusLabels[purchase.status] || purchase.status,
          raffle: purchase.raffle?.title || '-',
        });
      }
    };

    // Track totals for final summary
    const totals: { paymentMethod: string; currency: string; total: number; totalBs: number }[] = [];

    // 6. Create a worksheet for each payment method
    for (const pm of paymentMethods) {
      const pmPurchases = purchasesByPaymentMethod.get(pm.uid) || [];
      // Sanitize worksheet name (Excel limits to 31 chars and some special chars are not allowed)
      const sheetName = pm.name.slice(0, 31).replace(/[*?:/\\[\]]/g, '-');
      const worksheet = workbook.addWorksheet(sheetName);

      addHeaders(worksheet);
      addPurchaseRows(worksheet, pmPurchases);

      // Calculate total for this payment method
      const pmTotal = pmPurchases.reduce((sum, p) => sum + Number(p.totalAmount), 0);
      const pmCurrencySymbol = pm.currency?.symbol || 'USD';

      // When filtering by currency, all totals are already in that currency
      // No conversion needed - just sum up the amounts
      totals.push({
        paymentMethod: pm.name,
        currency: pmCurrencySymbol,
        total: pmTotal,
        totalBs: pmTotal, // Same value since we're already in the filtered currency
      });

      // Add total row at the end
      worksheet.addRow({});
      const totalRow = worksheet.addRow({
        date: '',
        customer: '',
        nationalId: '',
        email: '',
        phone: 'TOTAL:',
        ticketQty: pmPurchases.reduce((sum, p) => sum + p.ticketQuantity, 0),
        amount: pmTotal.toFixed(2),
        reference: '',
        status: '',
        raffle: '',
      });
      totalRow.font = { bold: true };
    }

    // 7. Create summary worksheet with totals
    const summaryCurrency = currency || 'Todas';
    const summarySheet = workbook.addWorksheet(`Totales ${summaryCurrency}`);
    summarySheet.columns = [
      { header: 'Método de Pago', key: 'paymentMethod', width: 30 },
      { header: 'Moneda', key: 'currency', width: 10 },
      { header: 'Total Original', key: 'total', width: 18 },
      { header: `Total en ${summaryCurrency}`, key: 'totalConverted', width: 18 },
    ];

    summarySheet.getRow(1).font = { bold: true };
    summarySheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    let grandTotal = 0;
    for (const t of totals) {
      summarySheet.addRow({
        paymentMethod: t.paymentMethod,
        currency: t.currency,
        total: t.total.toFixed(2),
        totalConverted: t.totalBs.toFixed(2),
      });
      grandTotal += t.totalBs;
    }

    // Grand total row
    summarySheet.addRow({});
    const grandTotalRow = summarySheet.addRow({
      paymentMethod: 'TOTAL GENERAL',
      currency: '',
      total: '',
      totalConverted: grandTotal.toFixed(2),
    });
    grandTotalRow.font = { bold: true };
    grandTotalRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFD700' },
    };

    // 8. Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // ===========================================================================
  // AI WEBHOOK (Restored & Refactored)
  // ===========================================================================

  async processAiWebhook(webhook: AiWebhookDto) {
    const { purchaseId, aiResult } = webhook;

    return this.dataSource.transaction(async (manager) => {
      // 1. Buscar la compra con todas las relaciones necesarias para validar
      const purchase = await manager.findOne(Purchase, {
        where: { uid: purchaseId },
        relations: ['raffle', 'paymentMethod', 'paymentMethod.currency'],
      });
      if (!purchase) throw new NotFoundException('Purchase not found');

      const wasVerified = purchase.status === PurchaseStatus.VERIFIED;

      // 2. Guardar el resultado crudo de la IA (para auditoría futura)
      purchase.aiAnalysisResult = aiResult ?? null;

      // Definir tipos para seguridad (Data que viene de la Lambda)
      interface ReceiptData {
        amount: number | null;
        currency: string | null;
        reference: string | null;
      }
      const aiData = aiResult as ReceiptData;

      // ---------------------------------------------------------
      // FASE DE VALIDACIÓN (Lógica de negocio)
      // ---------------------------------------------------------

      // A. Validar integridad básica de datos IA
      if (!aiData?.amount || !aiData?.currency || !aiData?.reference) {
        return this.handleManualReview(
          manager,
          purchase,
          'Purchase requires manual review (insufficient AI data)',
        );
      }

      // B. Validar Duplicados (Búsqueda difusa por referencia)
      // Limpiamos la referencia de la IA (solo números)
      const cleanAiRef = String(aiData.reference).replace(/\D/g, '');

      // Buscamos en BD si existe otra compra DIFERENTE con la misma referencia numérica
      const existingWithRef = await manager
        .getRepository(Purchase)
        .createQueryBuilder('p')
        .where('p.uid != :uid', { uid: purchaseId })
        // Postgres Regex: Elimina todo lo que no sea número de la columna bank_reference y compara
        .andWhere("REGEXP_REPLACE(p.bank_reference, '\\D', '', 'g') LIKE :ref", {
          ref: `%${cleanAiRef}%`,
        })
        .getOne();

      if (existingWithRef) {
        purchase.status = PurchaseStatus.DUPLICATED;
        const saved = await manager.save(Purchase, purchase);
        this.emitStatusChange(saved, 'duplicated', 'Purchase marked as duplicated');
        return this.serializePurchase(saved);
      }

      // C. Validar Monto (Margen de error de 0.01)
      const amountDiff = Math.abs(purchase.totalAmount - aiData.amount);
      const isAmountValid = amountDiff < 0.01;

      // D. Validar Moneda
      const expectedCurrency = purchase.paymentMethod?.currency;
      const isCurrencyValid = expectedCurrency?.symbol === aiData.currency;

      // E. Validar Referencia (Cotejo bidireccional)
      const cleanUserRef = purchase.bankReference.replace(/\D/g, '');
      const isRefValid =
        cleanAiRef.endsWith(cleanUserRef) || cleanUserRef.endsWith(cleanAiRef);

      // ---------------------------------------------------------
      // DECISIÓN FINAL
      // ---------------------------------------------------------

      if (isAmountValid && isCurrencyValid && isRefValid) {
        purchase.status = PurchaseStatus.VERIFIED;
        purchase.verifiedAt = new Date();
      } else {
        // Si falla algo, mandamos a revisión manual
        return this.handleManualReview(
          manager,
          purchase,
          `AI Validation Failed: Amount=${isAmountValid}, Currency=${isCurrencyValid}, Ref=${isRefValid}`,
        );
      }

      // Si pasa a VERIFIED y no lo estaba antes -> ASIGNAR TICKETS
      if (purchase.status === PurchaseStatus.VERIFIED && !wasVerified) {
        // ¡Aquí reutilizamos tu método privado seguro!
        await this.assignTickets(manager, purchase);
        return this.serializePurchase(purchase);
      }

      const updatedPurchase = await manager.save(Purchase, purchase);
      return this.serializePurchase(updatedPurchase);
    });
  }

  // ===========================================================================
  // PRIVATE HELPER METHODS (DRY - Don't Repeat Yourself)
  // ===========================================================================

  /**
   * Centralized Customer logic: Find existing and update, or create new.
   */
  private async getOrCreateCustomer(
    manager: EntityManager,
    data: { nationalId: string; fullName: string; email: string; phone: string },
  ): Promise<Customer> {
    const existingCustomer = await manager.findOne(Customer, {
      where: { nationalId: data.nationalId },
    });

    if (existingCustomer) {
      // Always update info to keep it fresh
      existingCustomer.fullName = data.fullName;
      existingCustomer.email = data.email;
      existingCustomer.phone = data.phone || existingCustomer.phone;
      return await manager.save(Customer, existingCustomer);
    }

    const newCustomer = manager.create(Customer, {
      nationalId: data.nationalId,
      fullName: data.fullName,
      email: data.email,
      phone: data.phone,
    });
    return await manager.save(Customer, newCustomer);
  }

  /**
   * Centralized S3 Upload logic with date-based folder structure.
   */
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

  /**
   * Resolve Raffle by External ID or Internal ID (UUID).
   */
  private async resolveRaffle(manager: EntityManager, id: string): Promise<Raffle> {
    let raffle = await manager.findOne(Raffle, { where: { externalId: id } });

    // Fallback: Check if it's a UUID and search by internal UID
    if (!raffle && this.isUUID(id)) {
        raffle = await manager.findOne(Raffle, { where: { uid: id } });
    }

    if (!raffle) {
      throw new NotFoundException(`Raffle not found (ID: ${id})`);
    }
    return raffle;
  }

  /**
   * Resolve Payment Method by External ID, Internal ID, or Name.
   */
  private async resolvePaymentMethod(
    manager: EntityManager,
    id: string,
    name?: string,
  ): Promise<PaymentMethod> {
    let pm = await manager.findOne(PaymentMethod, { where: { externalId: id } });

    // Fallback 1: Internal UUID
    if (!pm && this.isUUID(id)) {
        pm = await manager.findOne(PaymentMethod, { where: { uid: id } });
    }

    // Fallback 2: Name (fuzzy match)
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

  /**
   * Centralized Notification: SQS and Event Emitter.
   * Ensures the exact same message format for both flows.
   */
  private async notifyPostPurchase(purchase: Purchase, eventType: string) {
    // 1. Send to SQS (Critical for AI)
    try {
      await this.sqsService.sendPurchaseCreatedMessage(purchase);
    } catch (err) {
      this.logger.error(
        'Failed to send purchase created message to SQS.',
        err instanceof Error ? err.stack : String(err),
      );
      // We don't throw here to avoid rolling back the transaction just because SQS failed,
      // but you could throw if SQS is strictly required.
    }

    // 2. Emit Real-time Event (For Dashboard)
    this.eventEmitter.emit('purchase.created', {
      type: eventType,
      msg: 'New purchase created',
      raffleId: purchase.raffleId,
      purchaseId: purchase.uid,
    });
  }

  /**
   * Assign tickets safely using optimistic locking logic (unnest query).
   */
  private async assignTickets(manager: EntityManager, purchase: Purchase): Promise<void> {
    const raffle = await manager.findOne(Raffle, {
      where: { uid: purchase.raffleId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!raffle) throw new NotFoundException('Raffle not found');

    const soldTicketsRaw = await manager.query(
      `SELECT unnest("ticket_numbers") as num FROM purchase
       WHERE "raffle_id" = $1 AND "ticket_numbers" IS NOT NULL AND uid != $2`,
      [raffle.uid, purchase.uid],
    );

    const soldSet = new Set<number>(soldTicketsRaw.map((s: { num: number }) => Number(s.num)));
    const available = raffle.totalTickets - soldSet.size;

    if (available < purchase.ticketQuantity) {
      throw new ConflictException('Not enough tickets available.');
    }

    const toAssign: number[] = [];
    const maxAttempts = purchase.ticketQuantity * 10;
    let attempts = 0;

    while (toAssign.length < purchase.ticketQuantity && attempts < maxAttempts) {
      const randomNum = Math.floor(Math.random() * raffle.totalTickets);
      if (!soldSet.has(randomNum) && !toAssign.includes(randomNum)) {
        toAssign.push(randomNum);
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
      msg: 'Purchase verified and tickets assigned',
      raffleId: purchase.raffleId,
      purchaseId: purchase.uid,
      status: PurchaseStatus.VERIFIED,
      tickets: toAssign
    });
  }

  private isUUID(uuid: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
  }

  /**
   * Helper para manejar el flujo de revisión manual repetitivo
   */
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

  /**
   * Helper para emitir eventos de cambio de estado (SSE/Websockets)
   */
  private emitStatusChange(purchase: Purchase, type: string, msg: string) {
    this.eventEmitter.emit('purchase.status_changed', {
      type,
      msg,
      raffleId: purchase.raffleId,
      purchaseId: purchase.uid,
      status: purchase.status,
    });
  }

  /**
   * Helper para formatear la respuesta (aplanar estructura de moneda)
   */
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

