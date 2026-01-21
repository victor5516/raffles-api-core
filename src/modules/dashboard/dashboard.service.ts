import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Purchase, PurchaseStatus } from '../purchases/entities/purchase.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Raffle, RaffleStatus } from '../raffles/entities/raffle.entity';

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

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Purchase)
    private readonly purchaseRepository: Repository<Purchase>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
    @InjectRepository(Raffle)
    private readonly raffleRepository: Repository<Raffle>,
  ) {}

  async getOverview() {
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

  private async getRevenueMetric(args: {
    startOfToday: Date;
    now: Date;
    startOfYesterday: Date;
    endOfYesterday: Date;
  }): Promise<Metric> {
    const [todayRaw, yesterdayRaw] = await Promise.all([
      this.purchaseRepository
        .createQueryBuilder('purchase')
        .select('COALESCE(SUM(purchase.totalAmount), 0)', 'sum')
        .where('purchase.status = :status', { status: PurchaseStatus.VERIFIED })
        // Totales acumulados: NO filtramos por "now" para evitar discrepancias de timezone/reloj.
        .getRawOne<{ sum: string | number }>(),
      this.purchaseRepository
        .createQueryBuilder('purchase')
        .select('COALESCE(SUM(purchase.totalAmount), 0)', 'sum')
        .where('purchase.status = :status', { status: PurchaseStatus.VERIFIED })
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
        .select('COALESCE(SUM(purchase.ticketQuantity), 0)', 'sum')
        .where('purchase.status = :status', { status: PurchaseStatus.VERIFIED })
        // Totales acumulados: NO filtramos por "now" para evitar discrepancias de timezone/reloj.
        .getRawOne<{ sum: string | number }>(),
      this.purchaseRepository
        .createQueryBuilder('purchase')
        .select('COALESCE(SUM(purchase.ticketQuantity), 0)', 'sum')
        .where('purchase.status = :status', { status: PurchaseStatus.VERIFIED })
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
        .where('raffle.status = :raffleStatus', { raffleStatus: RaffleStatus.ACTIVE })
        .andWhere('purchase.status = :purchaseStatus', { purchaseStatus: PurchaseStatus.VERIFIED })
        .andWhere('purchase.verifiedAt IS NOT NULL')
        .getRawOne<{ count: string | number }>(),
      this.purchaseRepository
        .createQueryBuilder('purchase')
        .innerJoin('purchase.raffle', 'raffle')
        .select('COUNT(DISTINCT purchase.customerId)', 'count')
        .where('raffle.status = :raffleStatus', { raffleStatus: RaffleStatus.ACTIVE })
        .andWhere('purchase.status = :purchaseStatus', { purchaseStatus: PurchaseStatus.VERIFIED })
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

