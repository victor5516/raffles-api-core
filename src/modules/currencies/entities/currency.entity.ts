import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

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
