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

  async exportPurchases(filters: ExportPurchasesDto): Promise<Buffer> {
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
}
