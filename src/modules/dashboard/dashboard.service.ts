import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import {
  Purchase,
  PurchaseStatus,
  VerificationSource,
} from '../purchases/entities/purchase.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Raffle, RaffleStatus } from '../raffles/entities/raffle.entity';
import { Currency } from '../currencies/entities/currency.entity';
import { PaymentMethod } from '../payments/entities/payment-method.entity';
import { RaffleStatsResponseDto } from './dto/raffle-stats-response.dto';

const EXCLUDED_PURCHASE_STATUSES = [PurchaseStatus.REJECTED, PurchaseStatus.DUPLICATED];

type Metric = {
  current: number;
  previous: number;
  changePercent: number;
  isPositive: boolean;
};

type DashboardActiveRaffle = {
  uid: string;
  title: string;
  deadline: string;
  ticketsSold: number;
  percentageSold: number;
};

type RaffleSellDuration = {
  raffleCreatedAt: string;
  soldUntilAt: string;
  durationInHours: number;
  durationInDays: number;
} | null;

type RaffleTopLocation = {
  state: string;
  city: string | null;
  ticketsSold: number;
  purchasesCount: number;
  participantsCount: number;
};

type RaffleAmountByCurrency = {
  currencyId: string;
  currencyName: string;
  currencySymbol: string;
  amountCollected: number;
  exchangeRate: number;
  amountCollectedInUsd: number;
};

type RaffleAmountByPaymentMethod = {
  paymentMethodId: string;
  paymentMethodName: string;
  currencySymbol: string;
  amountCollected: number;
  exchangeRate: number;
  amountCollectedInUsd: number;
  totalPurchases: number;
};

type RaffleTicketsSoldByDay = {
  date: string;
  ticketsSold: number;
};

type RaffleAiAuditStats = {
  aiApprovedTotal: number;
  aiWithDoubleCheck: number;
  aiApprovedThenRejected: number;
  aiWithDoubleCheckEffective: number;
  aiRejectedSales: number;
};

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Purchase)
    private readonly purchaseRepository: Repository<Purchase>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
    @InjectRepository(Raffle)
    private readonly raffleRepository: Repository<Raffle>,
    @InjectRepository(Currency)
    private readonly currencyRepository: Repository<Currency>,
    @InjectRepository(PaymentMethod)
    private readonly paymentMethodRepository: Repository<PaymentMethod>,
  ) {}

  async getOverview(currencyId?: string) {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);

    const endOfYesterday = new Date(startOfToday.getTime() - 1);

    const [
      revenue,
      ticketsSold,
      participants,
      activeRafflesMetric,
      activeRaffles,
    ] = await Promise.all([
      this.getRevenueMetric({
        startOfToday,
        now,
        startOfYesterday,
        endOfYesterday,
        currencyId,
      }),
      this.getTicketsSoldMetric({
        startOfToday,
        now,
        startOfYesterday,
        endOfYesterday,
      }),
      this.getParticipantsMetric({
        startOfToday,
        now,
        startOfYesterday,
        endOfYesterday,
      }),
      this.getActiveRafflesMetric({ startOfToday }),
      this.getActiveRafflesList(),
    ]);

    return {
      metrics: {
        revenue,
        ticketsSold,
        activeRaffles: activeRafflesMetric,
        participants,
      },
      activeRaffles,
    };
  }

  async getTopCustomers(raffleId: string) {
    const topCustomers = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .innerJoin('purchase.customer', 'customer')
      .select('customer.uid', 'uid')
      .addSelect('customer.fullName', 'fullName')
      .addSelect('customer.email', 'email')
      .addSelect('SUM(purchase.ticketQuantity)', 'totalTickets')
      .where('purchase.raffleId = :raffleId', { raffleId })
      .andWhere('purchase.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: EXCLUDED_PURCHASE_STATUSES,
      })
      .groupBy('customer.uid')
      .addGroupBy('customer.fullName')
      .addGroupBy('customer.email')
      .orderBy('SUM(purchase.ticketQuantity)', 'DESC')
      .limit(10)
      .getRawMany();

    return topCustomers.map((c) => ({
      uid: c.uid,
      name: c.fullName,
      email: c.email,
      totalTickets: Number(c.totalTickets),
    }));
  }

  async getRaffleStats(raffleId: string): Promise<RaffleStatsResponseDto> {
    const raffle = await this.raffleRepository.findOne({ where: { uid: raffleId } });
    if (!raffle) {
      throw new NotFoundException('Raffle not found');
    }

    const [
      participantsCount,
      ticketsSold,
      totalPurchases,
      amountCollectedByCurrency,
      amountCollectedByPaymentMethod,
      ticketsSoldByDay,
      averageTimeBetweenSalesMinutes,
      sellDuration,
      topLocations,
      participantsWithoutLocation,
      aiAuditStats,
    ] = await Promise.all([
      this.getRaffleParticipants(raffleId),
      this.getRaffleTicketsSold(raffleId),
      this.getRaffleTotalPurchases(raffleId),
      this.getRaffleCollectedAmountByCurrency(raffleId),
      this.getRaffleCollectedByPaymentMethod(raffleId),
      this.getRaffleTicketsSoldByDay(raffleId),
      this.getAverageTimeBetweenSalesMinutes(raffleId),
      this.getRaffleSellDuration(raffleId, raffle.createdAt),
      this.getTopLocationsByRaffle(raffleId, 5),
      this.getRaffleParticipantsWithoutLocation(raffleId),
      this.getRaffleAiAuditStats(raffleId),
    ]);

    const salesPercentage =
      raffle.totalTickets > 0 ? (ticketsSold / raffle.totalTickets) * 100 : 0;
    const amountCollected = amountCollectedByCurrency.reduce(
      (sum, row) => sum + row.amountCollected,
      0,
    );

    const amountCollectedInUsd = this.computeRaffleAmountInUsd(
      amountCollectedByCurrency,
    );

    return {
      raffleId: raffle.uid,
      raffleTitle: raffle.title,
      participantsCount,
      ticketsSold,
      totalPurchases,
      averageTicketsPerPurchase:
        totalPurchases > 0 ? Number((ticketsSold / totalPurchases).toFixed(2)) : null,
      salesPercentage,
      sellDuration,
      topLocations,
      participantsWithoutLocation,
      amountCollected,
      amountCollectedByCurrency,
      amountCollectedByPaymentMethod,
      ticketsSoldByDay,
      averageTimeBetweenSalesMinutes,
      aiApprovedTotal: aiAuditStats.aiApprovedTotal,
      aiWithDoubleCheck: aiAuditStats.aiWithDoubleCheck,
      aiApprovedThenRejected: aiAuditStats.aiApprovedThenRejected,
      aiWithDoubleCheckEffective: aiAuditStats.aiWithDoubleCheckEffective,
      aiRejectedSales: aiAuditStats.aiRejectedSales,
      amountCollectedInUsd,
    };
  }

  private computeRaffleAmountInUsd(
    amountCollectedByCurrency: RaffleAmountByCurrency[],
  ): number {
    return amountCollectedByCurrency.reduce(
      (sum, row) => sum + row.amountCollectedInUsd,
      0,
    );
  }

  private computeChange(current: number, previous: number): Metric {
    if (!Number.isFinite(current)) current = 0;
    if (!Number.isFinite(previous)) previous = 0;

    if (previous === 0) {
      return {
        current,
        previous,
        changePercent: 0,
        isPositive: current > 0,
      };
    }

    const changePercent = ((current - previous) / previous) * 100;
    return {
      current,
      previous,
      changePercent,
      isPositive: changePercent > 0,
    };
  }

  private async getRaffleParticipants(raffleId: string): Promise<number> {
    const raw = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .select('COUNT(DISTINCT purchase.customerId)', 'count')
      .where('purchase.raffleId = :raffleId', { raffleId })
      .andWhere('purchase.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: EXCLUDED_PURCHASE_STATUSES,
      })
      .getRawOne<{ count: string | number }>();

    return Number(raw?.count ?? 0);
  }

  private async getRaffleTicketsSold(raffleId: string): Promise<number> {
    const raw = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .select('COALESCE(SUM(purchase.ticketQuantity), 0)', 'sum')
      .where('purchase.raffleId = :raffleId', { raffleId })
      .andWhere('purchase.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: EXCLUDED_PURCHASE_STATUSES,
      })
      .getRawOne<{ sum: string | number }>();

    return Number(raw?.sum ?? 0);
  }

  private async getRaffleTotalPurchases(raffleId: string): Promise<number> {
    const raw = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .select('COUNT(purchase.uid)', 'count')
      .where('purchase.raffleId = :raffleId', { raffleId })
      .andWhere('purchase.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: EXCLUDED_PURCHASE_STATUSES,
      })
      .getRawOne<{ count: string | number }>();

    return Number(raw?.count ?? 0);
  }

  private async getRafflePaymentsContext(raffleId: string): Promise<{
    purchases: Purchase[];
    paymentMethodsById: Map<string, PaymentMethod>;
  }> {
    const purchases = await this.purchaseRepository.find({
      where: {
        raffleId,
        status: Not(In(EXCLUDED_PURCHASE_STATUSES)),
      },
    });

    const methodIds = new Set<string>();

    for (const purchase of purchases) {
      if (purchase.paymentMethodId) {
        methodIds.add(purchase.paymentMethodId);
      }
      for (const pay of purchase.payments ?? []) {
        const paymentMethodId = String(pay.paymentMethodId ?? '').trim();
        if (paymentMethodId) {
          methodIds.add(paymentMethodId);
        }
      }
    }

    if (methodIds.size === 0) {
      return {
        purchases,
        paymentMethodsById: new Map<string, PaymentMethod>(),
      };
    }

    const paymentMethods = await this.paymentMethodRepository.find({
      where: {
        uid: In(Array.from(methodIds)),
      },
    });

    const paymentMethodsById = new Map<string, PaymentMethod>();
    for (const method of paymentMethods) {
      paymentMethodsById.set(method.uid, method);
    }

    return {
      purchases,
      paymentMethodsById,
    };
  }

  private async getRaffleCollectedAmountByCurrency(
    raffleId: string,
  ): Promise<RaffleAmountByCurrency[]> {
    const [currencies, { purchases, paymentMethodsById }] = await Promise.all([
      this.currencyRepository.find({
        order: { name: 'ASC' },
      }),
      this.getRafflePaymentsContext(raffleId),
    ]);

    const sumByCurrency = new Map<string, number>();

    for (const purchase of purchases) {
      const payments = purchase.payments ?? [];

      if (payments.length > 0) {
        for (const pay of payments) {
          const effectivePaymentMethodId =
            (pay.paymentMethodId && String(pay.paymentMethodId).trim()) ||
            purchase.paymentMethodId;
          if (!effectivePaymentMethodId) {
            continue;
          }

          const paymentMethod = paymentMethodsById.get(effectivePaymentMethodId);
          const currency = paymentMethod?.currency;
          if (!currency?.uid) {
            continue;
          }

          const amount = Number(pay.amount);
          if (!Number.isFinite(amount)) {
            continue;
          }

          const current = sumByCurrency.get(currency.uid) ?? 0;
          sumByCurrency.set(currency.uid, current + amount);
        }
      } else {
        const effectivePaymentMethodId = purchase.paymentMethodId;
        if (!effectivePaymentMethodId) {
          continue;
        }

        const paymentMethod = paymentMethodsById.get(effectivePaymentMethodId);
        const currency = paymentMethod?.currency;
        if (!currency?.uid) {
          continue;
        }

        const amount = Number(purchase.totalAmount ?? 0);
        if (!Number.isFinite(amount)) {
          continue;
        }

        const current = sumByCurrency.get(currency.uid) ?? 0;
        sumByCurrency.set(currency.uid, current + amount);
      }
    }

    return currencies.map((currency) => {
      const amountCollected = sumByCurrency.get(currency.uid) ?? 0;
      const value = Number(currency.value ?? 0);
      const rate = value > 0 ? value : 1;
      return {
        currencyId: currency.uid,
        currencyName: currency.name,
        currencySymbol: currency.symbol,
        amountCollected,
        exchangeRate: rate,
        amountCollectedInUsd: amountCollected / rate,
      };
    });
  }

  private async getRaffleCollectedByPaymentMethod(
    raffleId: string,
  ): Promise<RaffleAmountByPaymentMethod[]> {
    const { purchases, paymentMethodsById } =
      await this.getRafflePaymentsContext(raffleId);

    const aggregates = new Map<
      string,
      {
        paymentMethod: PaymentMethod;
        amountCollected: number;
        purchaseIds: Set<string>;
      }
    >();

    for (const purchase of purchases) {
      const payments = purchase.payments ?? [];

      if (payments.length > 0) {
        for (const pay of payments) {
          const effectivePaymentMethodId =
            (pay.paymentMethodId && String(pay.paymentMethodId).trim()) ||
            purchase.paymentMethodId;
          if (!effectivePaymentMethodId) {
            continue;
          }

          const paymentMethod = paymentMethodsById.get(effectivePaymentMethodId);
          if (!paymentMethod) {
            continue;
          }

          const amount = Number(pay.amount);
          if (!Number.isFinite(amount)) {
            continue;
          }

          let aggregate = aggregates.get(paymentMethod.uid);
          if (!aggregate) {
            aggregate = {
              paymentMethod,
              amountCollected: 0,
              purchaseIds: new Set<string>(),
            };
            aggregates.set(paymentMethod.uid, aggregate);
          }

          aggregate.amountCollected += amount;
          aggregate.purchaseIds.add(purchase.uid);
        }
      } else {
        const effectivePaymentMethodId = purchase.paymentMethodId;
        if (!effectivePaymentMethodId) {
          continue;
        }

        const paymentMethod = paymentMethodsById.get(effectivePaymentMethodId);
        if (!paymentMethod) {
          continue;
        }

        const amount = Number(purchase.totalAmount ?? 0);
        if (!Number.isFinite(amount)) {
          continue;
        }

        let aggregate = aggregates.get(paymentMethod.uid);
        if (!aggregate) {
          aggregate = {
            paymentMethod,
            amountCollected: 0,
            purchaseIds: new Set<string>(),
          };
          aggregates.set(paymentMethod.uid, aggregate);
        }

        aggregate.amountCollected += amount;
        aggregate.purchaseIds.add(purchase.uid);
      }
    }

    const result: RaffleAmountByPaymentMethod[] = [];

    for (const aggregate of aggregates.values()) {
      const { paymentMethod, amountCollected, purchaseIds } = aggregate;
      const currency = paymentMethod.currency;
      const value = Number(currency?.value ?? 0);
      const rate = value > 0 ? value : 1;

      result.push({
        paymentMethodId: paymentMethod.uid,
        paymentMethodName: paymentMethod.name,
        currencySymbol: currency?.symbol ?? '',
        amountCollected,
        exchangeRate: rate,
        amountCollectedInUsd: amountCollected / rate,
        totalPurchases: purchaseIds.size,
      });
    }

    result.sort((a, b) =>
      a.paymentMethodName.localeCompare(b.paymentMethodName, 'es', {
        sensitivity: 'base',
      }),
    );

    return result;
  }

  private async getRaffleTicketsSoldByDay(
    raffleId: string,
  ): Promise<RaffleTicketsSoldByDay[]> {
    const rows = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .select('purchase.submittedAt', 'submittedAt')
      .addSelect('purchase.ticketQuantity', 'ticketQuantity')
      .where('purchase.raffleId = :raffleId', { raffleId })
      .andWhere('purchase.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: EXCLUDED_PURCHASE_STATUSES,
      })
      .andWhere('purchase.submittedAt IS NOT NULL')
      .orderBy('purchase.submittedAt', 'ASC')
      .getRawMany<{ submittedAt: string | Date; ticketQuantity: string | number }>();

    const dayFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Caracas',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const soldByDay = new Map<string, number>();

    for (const row of rows) {
      const dateValue = row.submittedAt;
      if (!dateValue) continue;

      const submittedAt = new Date(dateValue);
      if (Number.isNaN(submittedAt.getTime())) continue;

      const dayKey = dayFormatter.format(submittedAt); // YYYY-MM-DD (en-CA)
      const current = soldByDay.get(dayKey) ?? 0;
      soldByDay.set(dayKey, current + Number(row.ticketQuantity ?? 0));
    }

    return Array.from(soldByDay.entries())
      .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
      .map(([date, ticketsSold]) => ({
        date,
        ticketsSold,
      }));
  }

  private async getAverageTimeBetweenSalesMinutes(
    raffleId: string,
  ): Promise<number | null> {
    const rows = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .select('COALESCE(purchase.verifiedAt, purchase.submittedAt)', 'soldAt')
      .where('purchase.raffleId = :raffleId', { raffleId })
      .andWhere('purchase.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: EXCLUDED_PURCHASE_STATUSES,
      })
      .andWhere('COALESCE(purchase.verifiedAt, purchase.submittedAt) IS NOT NULL')
      .orderBy('COALESCE(purchase.verifiedAt, purchase.submittedAt)', 'ASC')
      .getRawMany<{ soldAt: string | Date }>();

    if (rows.length < 2) {
      return null;
    }

    let totalDiffMs = 0;
    let intervals = 0;

    for (let i = 1; i < rows.length; i++) {
      const previous = new Date(rows[i - 1].soldAt).getTime();
      const current = new Date(rows[i].soldAt).getTime();
      const diff = current - previous;

      if (Number.isFinite(diff) && diff >= 0) {
        totalDiffMs += diff;
        intervals += 1;
      }
    }

    if (intervals === 0) {
      return null;
    }

    const averageMinutes = totalDiffMs / intervals / (1000 * 60);
    return Number(averageMinutes.toFixed(2));
  }

  private async getRaffleSellDuration(
    raffleId: string,
    raffleCreatedAt: Date,
  ): Promise<RaffleSellDuration> {
    const raw = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .select('MAX(COALESCE(purchase.verifiedAt, purchase.submittedAt))', 'soldUntilAt')
      .where('purchase.raffleId = :raffleId', { raffleId })
      .andWhere('purchase.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: EXCLUDED_PURCHASE_STATUSES,
      })
      .getRawOne<{ soldUntilAt: string | Date | null }>();

    const soldUntilAtValue = raw?.soldUntilAt;
    if (!soldUntilAtValue) {
      return null;
    }

    const soldUntilAt = new Date(soldUntilAtValue);
    const durationMs = soldUntilAt.getTime() - raffleCreatedAt.getTime();
    const durationInHours = durationMs > 0 ? durationMs / (1000 * 60 * 60) : 0;
    const durationInDays = durationInHours / 24;

    return {
      raffleCreatedAt: raffleCreatedAt.toISOString(),
      soldUntilAt: soldUntilAt.toISOString(),
      durationInHours,
      durationInDays,
    };
  }

  private async getTopLocationsByRaffle(
    raffleId: string,
    limit = 5,
  ): Promise<RaffleTopLocation[]> {
    const rows = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .innerJoin('purchase.customer', 'customer')
      .select("customer.location->>'state'", 'state')
      .addSelect("NULL", 'city')
      .addSelect('COALESCE(SUM(purchase.ticketQuantity), 0)', 'ticketsSold')
      .addSelect('COUNT(purchase.uid)', 'purchasesCount')
      .addSelect('COUNT(DISTINCT purchase.customerId)', 'participantsCount')
      .where('purchase.raffleId = :raffleId', { raffleId })
      .andWhere('purchase.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: EXCLUDED_PURCHASE_STATUSES,
      })
      .andWhere("customer.location->>'state' IS NOT NULL")
      .andWhere("customer.location->>'state' != ''")
      .groupBy("customer.location->>'state'")
      .orderBy('SUM(purchase.ticketQuantity)', 'DESC')
      .addOrderBy('COUNT(purchase.uid)', 'DESC')
      .limit(limit)
      .getRawMany<{
        state: string;
        city: string | null;
        ticketsSold: string | number;
        purchasesCount: string | number;
        participantsCount: string | number;
      }>();

    return rows.map((row) => ({
      state: row.state,
      city: row.city,
      ticketsSold: Number(row.ticketsSold ?? 0),
      purchasesCount: Number(row.purchasesCount ?? 0),
      participantsCount: Number(row.participantsCount ?? 0),
    }));
  }

  private async getRaffleParticipantsWithoutLocation(
    raffleId: string,
  ): Promise<number> {
    const raw = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .innerJoin('purchase.customer', 'customer')
      .select('COUNT(DISTINCT purchase.customerId)', 'count')
      .where('purchase.raffleId = :raffleId', { raffleId })
      .andWhere('purchase.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: EXCLUDED_PURCHASE_STATUSES,
      })
      .andWhere(
        "(customer.location->>'state' IS NULL OR customer.location->>'state' = '')",
      )
      .getRawOne<{ count: string | number }>();

    return Number(raw?.count ?? 0);
  }

  private async getRaffleAiAuditStats(
    raffleId: string,
  ): Promise<RaffleAiAuditStats> {
    const raw = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .select(
        `COUNT(*) FILTER (WHERE purchase.verificationSource = :aiSource)`,
        'aiApprovedTotal',
      )
      .addSelect(
        `COUNT(*) FILTER (
          WHERE purchase.verificationSource = :aiSource
            AND purchase.auditReviewedAt IS NOT NULL
        )`,
        'aiWithDoubleCheck',
      )
      .addSelect(
        `COUNT(*) FILTER (
          WHERE purchase.verificationSource = :aiSource
            AND purchase.status = :rejectedStatus
        )`,
        'aiApprovedThenRejected',
      )
      .addSelect(
        `COUNT(*) FILTER (
          WHERE purchase.verificationSource = :aiSource
            AND purchase.auditReviewedAt IS NOT NULL
            AND purchase.status != :rejectedStatus
        )`,
        'aiWithDoubleCheckEffective',
      )
      .addSelect(
        `COUNT(*) FILTER (
          WHERE purchase.aiAnalysisResult IS NOT NULL
            AND (
              purchase.status = :manualReviewStatus
              OR purchase.status = :duplicatedStatus
              OR purchase.status = :rejectedStatus
            )
            AND (
              purchase.verificationSource IS NULL
              OR purchase.verificationSource != :aiSource
            )
        )`,
        'aiRejectedSales',
      )
      .where('purchase.raffleId = :raffleId', { raffleId })
      .setParameters({
        aiSource: VerificationSource.AI,
        rejectedStatus: PurchaseStatus.REJECTED,
        manualReviewStatus: PurchaseStatus.MANUAL_REVIEW,
        duplicatedStatus: PurchaseStatus.DUPLICATED,
      })
      .getRawOne<{
        aiApprovedTotal: string | number;
        aiWithDoubleCheck: string | number;
        aiApprovedThenRejected: string | number;
        aiWithDoubleCheckEffective: string | number;
        aiRejectedSales: string | number;
      }>();

    return {
      aiApprovedTotal: Number(raw?.aiApprovedTotal ?? 0),
      aiWithDoubleCheck: Number(raw?.aiWithDoubleCheck ?? 0),
      aiApprovedThenRejected: Number(raw?.aiApprovedThenRejected ?? 0),
      aiWithDoubleCheckEffective: Number(raw?.aiWithDoubleCheckEffective ?? 0),
      aiRejectedSales: Number(raw?.aiRejectedSales ?? 0),
    };
  }

  private async getRevenueMetric(args: {
    startOfToday: Date;
    now: Date;
    startOfYesterday: Date;
    endOfYesterday: Date;
    currencyId?: string;
  }): Promise<Metric> {
    const [todayRaw, yesterdayRaw] = await Promise.all([
      this.purchaseRepository
        .createQueryBuilder('purchase')
        .innerJoin('purchase.raffle', 'raffle')
        .innerJoin('purchase.paymentMethod', 'paymentMethod')
        .select('COALESCE(SUM(purchase.totalAmount), 0)', 'sum')
        .where('raffle.status = :raffleStatus', {
          raffleStatus: RaffleStatus.ACTIVE,
        })
        .andWhere('purchase.status = :status', { status: PurchaseStatus.VERIFIED })
        .andWhere(
          args.currencyId ? 'paymentMethod.currencyId = :currencyId' : '1=1',
          { currencyId: args.currencyId },
        )
        // Totales acumulados: NO filtramos por "now" para evitar discrepancias de timezone/reloj.
        .getRawOne<{ sum: string | number }>(),
      this.purchaseRepository
        .createQueryBuilder('purchase')
        .innerJoin('purchase.raffle', 'raffle')
        .innerJoin('purchase.paymentMethod', 'paymentMethod')
        .select('COALESCE(SUM(purchase.totalAmount), 0)', 'sum')
        .where('raffle.status = :raffleStatus', {
          raffleStatus: RaffleStatus.ACTIVE,
        })
        .andWhere('purchase.status = :status', { status: PurchaseStatus.VERIFIED })
        .andWhere(
          args.currencyId ? 'paymentMethod.currencyId = :currencyId' : '1=1',
          { currencyId: args.currencyId },
        )
        .andWhere(
          'COALESCE(purchase.verifiedAt, purchase.submittedAt) <= :end',
          { end: args.endOfYesterday },
        )
        .getRawOne<{ sum: string | number }>(),
    ]);

    const today = Number(todayRaw?.sum ?? 0);
    const yesterday = Number(yesterdayRaw?.sum ?? 0);
    return this.computeChange(today, yesterday);
  }

  private async getTicketsSoldMetric(args: {
    startOfToday: Date;
    now: Date;
    startOfYesterday: Date;
    endOfYesterday: Date;
  }): Promise<Metric> {
    const [todayRaw, yesterdayRaw] = await Promise.all([
      this.purchaseRepository
        .createQueryBuilder('purchase')
        .innerJoin('purchase.raffle', 'raffle')
        .select('COALESCE(SUM(purchase.ticketQuantity), 0)', 'sum')
        .where('raffle.status = :raffleStatus', {
          raffleStatus: RaffleStatus.ACTIVE,
        })
        .andWhere('purchase.status = :status', { status: PurchaseStatus.VERIFIED })
        // Totales acumulados: NO filtramos por "now" para evitar discrepancias de timezone/reloj.
        .getRawOne<{ sum: string | number }>(),
      this.purchaseRepository
        .createQueryBuilder('purchase')
        .innerJoin('purchase.raffle', 'raffle')
        .select('COALESCE(SUM(purchase.ticketQuantity), 0)', 'sum')
        .where('raffle.status = :raffleStatus', {
          raffleStatus: RaffleStatus.ACTIVE,
        })
        .andWhere('purchase.status = :status', { status: PurchaseStatus.VERIFIED })
        .andWhere(
          'COALESCE(purchase.verifiedAt, purchase.submittedAt) <= :end',
          { end: args.endOfYesterday },
        )
        .getRawOne<{ sum: string | number }>(),
    ]);

    const today = Number(todayRaw?.sum ?? 0);
    const yesterday = Number(yesterdayRaw?.sum ?? 0);
    return this.computeChange(today, yesterday);
  }

  private async getParticipantsMetric(args: {
    startOfToday: Date;
    now: Date;
    startOfYesterday: Date;
    endOfYesterday: Date;
  }): Promise<Metric> {
    // "Participantes": clientes únicos con compras verificadas en rifas ACTIVAS (acumulado).
    // Para el % vs ayer: mismo conteo pero considerando compras verificadas hasta fin de ayer.
    const [currentRaw, previousRaw] = await Promise.all([
      this.purchaseRepository
        .createQueryBuilder('purchase')
        .innerJoin('purchase.raffle', 'raffle')
        .select('COUNT(DISTINCT purchase.customerId)', 'count')
        .where('raffle.status = :raffleStatus', {
          raffleStatus: RaffleStatus.ACTIVE,
        })
        .andWhere('purchase.status = :purchaseStatus', {
          purchaseStatus: PurchaseStatus.VERIFIED,
        })
        .andWhere('purchase.verifiedAt IS NOT NULL')
        .getRawOne<{ count: string | number }>(),
      this.purchaseRepository
        .createQueryBuilder('purchase')
        .innerJoin('purchase.raffle', 'raffle')
        .select('COUNT(DISTINCT purchase.customerId)', 'count')
        .where('raffle.status = :raffleStatus', {
          raffleStatus: RaffleStatus.ACTIVE,
        })
        .andWhere('purchase.status = :purchaseStatus', {
          purchaseStatus: PurchaseStatus.VERIFIED,
        })
        .andWhere('purchase.verifiedAt IS NOT NULL')
        .andWhere('purchase.verifiedAt <= :end', { end: args.endOfYesterday })
        .getRawOne<{ count: string | number }>(),
    ]);

    const current = Number(currentRaw?.count ?? 0);
    const previous = Number(previousRaw?.count ?? 0);
    return this.computeChange(current, previous);
  }

  private async getActiveRafflesMetric(args: {
    startOfToday: Date;
  }): Promise<Metric> {
    const [current, previous] = await Promise.all([
      this.raffleRepository.count({
        where: { status: RaffleStatus.ACTIVE },
      }),
      this.raffleRepository
        .createQueryBuilder('raffle')
        .where('raffle.status = :status', { status: RaffleStatus.ACTIVE })
        .andWhere('raffle.createdAt < :start', { start: args.startOfToday })
        .getCount(),
    ]);

    return this.computeChange(current, previous);
  }

  private async getActiveRafflesList(): Promise<DashboardActiveRaffle[]> {
    const activeRaffles = await this.raffleRepository.find({
      where: { status: RaffleStatus.ACTIVE },
      order: { createdAt: 'DESC' },
    });

    if (activeRaffles.length === 0) return [];

    const soldByRaffleRaw = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .select('purchase.raffleId', 'raffleId')
      .addSelect('COALESCE(SUM(purchase.ticketQuantity), 0)', 'ticketsSold')
      .where('purchase.status = :status', { status: PurchaseStatus.VERIFIED })
      .groupBy('purchase.raffleId')
      .getRawMany<{ raffleId: string; ticketsSold: string | number }>();

    const soldByRaffle = new Map<string, number>(
      soldByRaffleRaw.map((r) => [r.raffleId, Number(r.ticketsSold ?? 0)]),
    );

    return activeRaffles.map((r) => {
      const ticketsSold = soldByRaffle.get(r.uid) ?? 0;
      const percentageSold =
        r.totalTickets > 0 ? (ticketsSold / r.totalTickets) * 100 : 0;

      return {
        uid: r.uid,
        title: r.title,
        deadline: r.deadline.toISOString(),
        ticketsSold,
        percentageSold,
      };
    });
  }
}
