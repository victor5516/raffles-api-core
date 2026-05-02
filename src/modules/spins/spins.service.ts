import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  MoreThan,
  Repository,
} from 'typeorm';
import { SpinPrize } from './entities/spin-prize.entity';
import { SpinToken } from './entities/spin-token.entity';
import { SpinResult } from './entities/spin-result.entity';
import { SpinTokenSource } from './enums/spin-token-source.enum';
import type { ListAdminSpinResultsQueryDto } from './dto/list-admin-spin-results.query.dto';
import type { ListUnusedPromoTokensQueryDto } from './dto/list-unused-promo-tokens.query.dto';

export interface AdminSpinResultView {
  id: string;
  spinTokenId: string;
  createdAt: Date;
  source: SpinTokenSource;
  customer: {
    id: string;
    fullName: string;
    email: string;
    nationalId: string;
    phone: string | null;
  } | null;
  prize: {
    id: string;
    name: string;
    type: string;
  };
}

@Injectable()
export class SpinsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(SpinPrize)
    private readonly spinPrizeRepository: Repository<SpinPrize>,
    @InjectRepository(SpinToken)
    private readonly spinTokenRepository: Repository<SpinToken>,
    @InjectRepository(SpinResult)
    private readonly spinResultRepository: Repository<SpinResult>,
  ) {}

  async createPromoLinkTokens(quantity: number): Promise<string[]> {
    const payload = Array.from({ length: quantity }, () =>
      this.spinTokenRepository.create({
        source: SpinTokenSource.PROMO_LINK,
        isUsed: false,
      }),
    );
    const created = await this.spinTokenRepository.save(payload);
    return created.map((token) => token.id);
  }

  async findAvailableCustomerTokens(customerId: string): Promise<SpinToken[]> {
    return this.spinTokenRepository.find({
      where: [
        { customerId, isUsed: false, expiresAt: IsNull() },
        { customerId, isUsed: false, expiresAt: MoreThan(new Date()) },
      ],
      order: { createdAt: 'DESC' },
    });
  }

  private mapSpinResultToAdminView(result: SpinResult): AdminSpinResultView {
    const c = result.spinToken.customer;
    return {
      id: result.id,
      spinTokenId: result.spinTokenId,
      createdAt: result.createdAt,
      source: result.spinToken.source,
      customer: c
        ? {
            id: c.uid,
            fullName: c.fullName,
            email: c.email,
            nationalId: c.nationalId,
            phone: c.phone ?? null,
          }
        : null,
      prize: {
        id: result.prize.id,
        name: result.prize.name,
        type: result.prize.type,
      },
    };
  }

  async findAdminSpinResultsPaginated(
    query: ListAdminSpinResultsQueryDto,
  ): Promise<{ items: AdminSpinResultView[]; total: number }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 10));
    const skip = (page - 1) * limit;

    const qb = this.spinResultRepository
      .createQueryBuilder('sr')
      .innerJoinAndSelect('sr.spinToken', 'st')
      .leftJoinAndSelect('st.customer', 'c')
      .innerJoinAndSelect('sr.prize', 'p');

    const customerName = query.customerName?.trim();
    if (customerName) {
      qb.andWhere('c.fullName ILIKE :customerName', {
        customerName: `%${customerName}%`,
      });
    }
    const nationalId = query.nationalId?.trim();
    if (nationalId) {
      qb.andWhere('c.nationalId ILIKE :nationalId', {
        nationalId: `%${nationalId}%`,
      });
    }
    const phone = query.phone?.trim();
    if (phone) {
      qb.andWhere('c.phone ILIKE :phone', { phone: `%${phone}%` });
    }
    if (query.prizeId) {
      qb.andWhere('sr.prizeId = :prizeId', { prizeId: query.prizeId });
    }
    if (query.dateFrom) {
      const dateFromStart = new Date(query.dateFrom);
      dateFromStart.setHours(0, 0, 0, 0);
      qb.andWhere('sr.createdAt >= :dateFrom', { dateFrom: dateFromStart });
    }
    if (query.dateTo) {
      const dateToEnd = new Date(query.dateTo);
      dateToEnd.setHours(23, 59, 59, 999);
      qb.andWhere('sr.createdAt <= :dateTo', { dateTo: dateToEnd });
    }

    qb.orderBy('sr.createdAt', 'DESC').skip(skip).take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((r) => this.mapSpinResultToAdminView(r)),
      total,
    };
  }

  /**
   * Active prizes eligible for spinning (same filter as spinTheWheel).
   * Public-safe fields only.
   */
  async findWheelPrizesForPublic(): Promise<
    Pick<SpinPrize, 'id' | 'name' | 'type'>[]
  > {
    const rows = await this.spinPrizeRepository
      .createQueryBuilder('prize')
      .select(['prize.id', 'prize.name', 'prize.type'])
      .where('prize.is_active = :isActive', { isActive: true })
      .andWhere('(prize.inventory IS NULL OR prize.inventory > 0)')
      .orderBy('prize.name', 'ASC')
      .addOrderBy('prize.id', 'ASC')
      .getMany();

    return rows.map((p) => ({ id: p.id, name: p.name, type: p.type }));
  }

  /** Promo-link tokens not yet redeemed (admin list for distribution). */
  async findAdminUnusedPromoLinkTokensPaginated(
    query: ListUnusedPromoTokensQueryDto,
  ): Promise<{ items: Pick<SpinToken, 'id' | 'createdAt'>[]; total: number }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 10));
    const skip = (page - 1) * limit;

    const qb = this.spinTokenRepository
      .createQueryBuilder('t')
      .where('t.source = :source', { source: SpinTokenSource.PROMO_LINK })
      .andWhere('t.isUsed = :isUsed', { isUsed: false });

    if (query.dateFrom) {
      const dateFromStart = new Date(query.dateFrom);
      dateFromStart.setHours(0, 0, 0, 0);
      qb.andWhere('t.createdAt >= :dateFrom', { dateFrom: dateFromStart });
    }
    if (query.dateTo) {
      const dateToEnd = new Date(query.dateTo);
      dateToEnd.setHours(23, 59, 59, 999);
      qb.andWhere('t.createdAt <= :dateTo', { dateTo: dateToEnd });
    }

    qb.orderBy('t.createdAt', 'DESC').skip(skip).take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((t) => ({ id: t.id, createdAt: t.createdAt })),
      total,
    };
  }

  async spinTheWheel(tokenId: string, customerId?: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const token = await queryRunner.manager
        .createQueryBuilder(SpinToken, 'token')
        .setLock('pessimistic_write')
        .where('token.id = :tokenId', { tokenId })
        .getOne();

      if (!token) {
        throw new NotFoundException('Spin token not found');
      }

      if (customerId && token.customerId && token.customerId !== customerId) {
        throw new ForbiddenException('Spin token does not belong to customer');
      }

      if (token.isUsed) {
        throw new BadRequestException('Spin token already used');
      }

      if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('Spin token expired');
      }

      const candidatePrizes = await queryRunner.manager
        .createQueryBuilder(SpinPrize, 'prize')
        .where('prize.is_active = :isActive', { isActive: true })
        .andWhere('(prize.inventory IS NULL OR prize.inventory > 0)')
        .getMany();

      if (!candidatePrizes.length) {
        throw new NotFoundException('No active prizes available');
      }

      const winnerPrize = this.pickWeightedPrize(candidatePrizes);

      if (winnerPrize.inventory !== null) {
        const updateResult = await queryRunner.manager
          .createQueryBuilder()
          .update(SpinPrize)
          .set({ inventory: () => 'inventory - 1' })
          .where('id = :id', { id: winnerPrize.id })
          .andWhere('inventory > 0')
          .execute();

        if (!updateResult.affected) {
          throw new ConflictException(
            'Prize inventory just ran out. Please try again.',
          );
        }
      }

      token.isUsed = true;
      await queryRunner.manager.save(SpinToken, token);

      const spinResult = this.spinResultRepository.create({
        spinTokenId: token.id,
        prizeId: winnerPrize.id,
      });
      await queryRunner.manager.save(SpinResult, spinResult);

      await queryRunner.commitTransaction();

      return {
        spinResultId: spinResult.id,
        tokenId: token.id,
        prize: {
          id: winnerPrize.id,
          name: winnerPrize.name,
          type: winnerPrize.type,
        },
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async grantPurchaseRewardTokens(params: {
    customerId: string;
    purchasedTickets: number;
    sourceReferenceBase: string;
    manager?: EntityManager;
  }): Promise<{ requested: number; granted: number }> {
    const execute = async (
      manager: EntityManager,
    ): Promise<{ requested: number; granted: number }> => {
      if (!params.customerId || params.purchasedTickets <= 0) {
        return { requested: 0, granted: 0 };
      }

      const requested = Math.floor(params.purchasedTickets / 100);
      if (requested <= 0) {
        return { requested: 0, granted: 0 };
      }

      const references = Array.from(
        { length: requested },
        (_, index) => `${params.sourceReferenceBase}:${index + 1}`,
      );

      const existing = await manager.find(SpinToken, {
        select: { sourceReference: true },
        where: {
          source: SpinTokenSource.PURCHASE_REWARD,
          sourceReference: In(references),
        },
      });
      const existingReferences = new Set(
        existing.map((token) => token.sourceReference),
      );

      const payload = references
        .filter((reference) => !existingReferences.has(reference))
        .map((reference) =>
          manager.create(SpinToken, {
            customerId: params.customerId,
            source: SpinTokenSource.PURCHASE_REWARD,
            sourceReference: reference,
            isUsed: false,
          }),
        );

      if (!payload.length) {
        return { requested, granted: 0 };
      }

      const saved = await manager.save(SpinToken, payload);
      return { requested, granted: saved.length };
    };

    if (params.manager) {
      return execute(params.manager);
    }
    return this.dataSource.transaction((manager) => execute(manager));
  }

  private pickWeightedPrize(prizes: SpinPrize[]): SpinPrize {
    const totalWeight = prizes.reduce((sum, prize) => sum + prize.weight, 0);
    if (totalWeight <= 0) {
      throw new BadRequestException('Invalid prize weight configuration');
    }

    const randomWeight = Math.random() * totalWeight;
    let cumulative = 0;

    for (const prize of prizes) {
      cumulative += prize.weight;
      if (randomWeight <= cumulative) {
        return prize;
      }
    }

    return prizes[prizes.length - 1];
  }
}
