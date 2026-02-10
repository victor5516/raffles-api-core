import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { Purchase } from '../../purchases/entities/purchase.entity';

@Entity('customer')
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  uid: string;

  @Column({ name: 'national_id', unique: true })
  nationalId: string;

  @Column({ name: 'full_name' })
  fullName: string;

  @Column()
  email: string;

  @Column({ nullable: true })
  phone: string;

  @Column({ type: 'jsonb', nullable: true })
  location: Record<string, any>;

  @Column({ name: 'is_blacklisted', default: false })
  isBlacklisted: boolean;

  @Column({ name: 'blacklist_reason', nullable: true })
  blacklistReason: string | null;

  @Column({ name: 'blacklisted_at', type: 'timestamptz', nullable: true })
  blacklistedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => Purchase, (purchase) => purchase.customer)
  purchases: Purchase[];
}
