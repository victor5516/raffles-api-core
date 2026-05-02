import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Customer } from '../../customers/entities/customer.entity';
import { SpinTokenSource } from '../enums/spin-token-source.enum';
import { SpinResult } from './spin-result.entity';

@Entity('spin_token')
export class SpinToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId: string | null;

  @ManyToOne(() => Customer, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer | null;

  @Column({
    type: 'enum',
    enum: SpinTokenSource,
  })
  source: SpinTokenSource;

  @Column({ name: 'source_reference', type: 'varchar', length: 120, nullable: true })
  sourceReference: string | null;

  @Column({ name: 'is_used', type: 'boolean', default: false })
  isUsed: boolean;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToOne(() => SpinResult, (spinResult) => spinResult.spinToken)
  spinResult: SpinResult | null;
}
