import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, In } from 'typeorm';
import * as crypto from 'crypto';
import { Coupon } from './entities/coupon.entity';
import { Admin } from '../auth/entities/admin.entity';
import { GenerateCouponsDto } from './dto/generate-coupons.dto';
import { FilterCouponsDto, CouponStatus } from './dto/filter-coupons.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

@Injectable()
export class CouponsService {
  constructor(
    @InjectRepository(Coupon)
    private readonly couponRepository: Repository<Coupon>,
  ) {}

  private generateCode(): string {
    const bytes = crypto.randomBytes(6);
    return Array.from(bytes)
      .map((b) => CHARSET[b % CHARSET.length])
      .join('');
  }

  async generateBatch(
    dto: GenerateCouponsDto,
    admin: Admin,
  ): Promise<string[]> {
    const expiresAt = new Date(dto.expiresAt);
    const codes = new Set<string>();

    while (codes.size < dto.count) {
      codes.add(this.generateCode());
    }

    const candidateCodes = [...codes];

    const existing = await this.couponRepository.find({
      where: { code: In(candidateCodes) },
      select: ['code'],
    });
    const existingSet = new Set(existing.map((c) => c.code));

    const uniqueCodes = candidateCodes.filter((c) => !existingSet.has(c));

    const uniqueCodesSet = new Set(uniqueCodes);
    while (uniqueCodes.length < dto.count) {
      const extra = this.generateCode();
      if (!existingSet.has(extra) && !uniqueCodesSet.has(extra)) {
        uniqueCodes.push(extra);
        uniqueCodesSet.add(extra);
      }
    }

    const finalCodes = uniqueCodes.slice(0, dto.count);
    const entities = finalCodes.map((code) =>
      this.couponRepository.create({
        code,
        isActive: true,
        expiresAt,
        createdById: admin.uid,
      }),
    );

    await this.couponRepository.save(entities);
    return finalCodes;
  }

  async validateAndLock(
    codes: string[],
    manager: EntityManager,
  ): Promise<Coupon[]> {
    const coupons = await manager.find(Coupon, {
      where: { code: In(codes) },
      lock: { mode: 'pessimistic_write' },
    });

    const now = new Date();
    for (const code of codes) {
      const coupon = coupons.find((c) => c.code === code);
      if (!coupon) {
        throw new BadRequestException(`Cupón ${code} no existe`);
      }
      if (!coupon.isActive) {
        throw new BadRequestException(`Cupón ${code} está desactivado`);
      }
      if (coupon.redeemedAt !== null) {
        throw new BadRequestException(`Cupón ${code} ya fue canjeado`);
      }
      if (coupon.expiresAt <= now) {
        throw new BadRequestException(`Cupón ${code} está expirado`);
      }
    }

    return coupons;
  }

  async redeemCoupons(
    coupons: Coupon[],
    purchaseId: string,
    manager: EntityManager,
  ): Promise<void> {
    const codes = coupons.map((c) => c.code);
    await manager.update(
      Coupon,
      { code: In(codes) },
      { redeemedAt: new Date(), purchaseId },
    );
  }

  async findAll(
    dto: FilterCouponsDto,
  ): Promise<{ data: Coupon[]; total: number }> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const now = new Date();

    const qb = this.couponRepository
      .createQueryBuilder('coupon')
      .leftJoinAndSelect('coupon.createdBy', 'createdBy')
      .select([
        'coupon.code',
        'coupon.isActive',
        'coupon.expiresAt',
        'coupon.redeemedAt',
        'coupon.purchaseId',
        'coupon.createdById',
        'coupon.createdAt',
        'createdBy.email',
      ]);

    if (dto.search) {
      qb.andWhere('coupon.code ILIKE :search', {
        search: `%${dto.search}%`,
      });
    }

    if (dto.status) {
      switch (dto.status) {
        case CouponStatus.AVAILABLE:
          qb.andWhere('coupon.isActive = true')
            .andWhere('coupon.redeemedAt IS NULL')
            .andWhere('coupon.expiresAt > :now', { now });
          break;
        case CouponStatus.REDEEMED:
          qb.andWhere('coupon.redeemedAt IS NOT NULL');
          break;
        case CouponStatus.EXPIRED:
          qb.andWhere('coupon.isActive = true')
            .andWhere('coupon.redeemedAt IS NULL')
            .andWhere('coupon.expiresAt <= :now', { now });
          break;
        case CouponStatus.INACTIVE:
          qb.andWhere('coupon.isActive = false');
          break;
      }
    }

    const [data, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total };
  }

  async getStats(): Promise<{
    available: number;
    redeemed: number;
    expired: number;
    inactive: number;
  }> {
    const now = new Date();

    const [available, redeemed, expired, inactive] = await Promise.all([
      this.couponRepository
        .createQueryBuilder('c')
        .where('c.isActive = :active', { active: true })
        .andWhere('c.redeemedAt IS NULL')
        .andWhere('c.expiresAt > :now', { now })
        .getCount(),
      this.couponRepository
        .createQueryBuilder('c')
        .where('c.redeemedAt IS NOT NULL')
        .getCount(),
      this.couponRepository
        .createQueryBuilder('c')
        .where('c.isActive = :active', { active: true })
        .andWhere('c.redeemedAt IS NULL')
        .andWhere('c.expiresAt <= :now', { now })
        .getCount(),
      this.couponRepository
        .createQueryBuilder('c')
        .where('c.isActive = :active', { active: false })
        .getCount(),
    ]);

    return { available, redeemed, expired, inactive };
  }

  async findOne(code: string): Promise<Coupon> {
    const coupon = await this.couponRepository.findOne({
      where: { code },
      relations: ['purchase', 'createdBy'],
    });
    if (!coupon) throw new NotFoundException(`Cupón ${code} no encontrado`);
    return coupon;
  }

  async update(code: string, dto: UpdateCouponDto): Promise<Coupon> {
    const coupon = await this.couponRepository.findOne({ where: { code } });
    if (!coupon) throw new NotFoundException(`Cupón ${code} no encontrado`);
    if (coupon.redeemedAt !== null) {
      throw new BadRequestException(
        'No se puede modificar un cupón ya canjeado',
      );
    }
    if (dto.isActive !== undefined) coupon.isActive = dto.isActive;
    if (dto.expiresAt !== undefined) coupon.expiresAt = new Date(dto.expiresAt);
    return this.couponRepository.save(coupon);
  }

  async remove(code: string): Promise<void> {
    const coupon = await this.couponRepository.findOne({ where: { code } });
    if (!coupon) throw new NotFoundException(`Cupón ${code} no encontrado`);
    if (coupon.redeemedAt !== null) {
      throw new BadRequestException(
        'No se puede eliminar un cupón ya canjeado',
      );
    }
    coupon.isActive = false;
    await this.couponRepository.save(coupon);
  }

  async findByPurchaseId(
    purchaseId: string,
  ): Promise<{ code: string; redeemedAt: Date | null }[]> {
    const coupons = await this.couponRepository.find({
      where: { purchaseId },
      select: ['code', 'redeemedAt'],
    });
    return coupons.map((c) => ({ code: c.code, redeemedAt: c.redeemedAt }));
  }
}
