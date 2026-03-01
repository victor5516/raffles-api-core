import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Admin } from '../../auth/entities/admin.entity';
import { Purchase } from '../../purchases/entities/purchase.entity';

@Entity('coupon')
export class Coupon {
  @PrimaryColumn({ length: 6 })
  code: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;

  @Column({ name: 'redeemed_at', type: 'timestamp', nullable: true })
  redeemedAt: Date | null;

  @Column({ name: 'purchase_id', type: 'uuid', nullable: true })
  purchaseId: string | null;

  @ManyToOne(() => Purchase, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'purchase_id' })
  purchase: Purchase | null;

  @Column({ name: 'created_by_id', type: 'uuid' })
  createdById: string;

  @ManyToOne(() => Admin, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_id' })
  createdBy: Admin;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  get isRedeemable(): boolean {
    return (
      this.isActive && this.redeemedAt === null && this.expiresAt > new Date()
    );
  }
}
