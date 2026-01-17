import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { Purchase } from '../../purchases/entities/purchase.entity';

@Entity('currency')
export class Currency {
  @PrimaryGeneratedColumn('uuid')
  uid: string;

  @Column({ unique: true })
  name: string;

  @Column({ unique: true })
  symbol: string;

  @Column({ type: 'decimal' })
  value: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

}
