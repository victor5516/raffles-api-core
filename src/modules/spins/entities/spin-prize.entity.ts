import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SpinPrizeType } from '../enums/spin-prize-type.enum';
import { SpinResult } from './spin-result.entity';

@Entity('spin_prize')
export class SpinPrize {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({
    type: 'enum',
    enum: SpinPrizeType,
  })
  type: SpinPrizeType;

  @Column({ type: 'int' })
  weight: number;

  @Column({ type: 'int', nullable: true })
  inventory: number | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => SpinResult, (spinResult) => spinResult.prize)
  spinResults: SpinResult[];
}
