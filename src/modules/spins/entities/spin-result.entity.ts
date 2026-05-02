import {
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  Column,
} from 'typeorm';
import { SpinPrize } from './spin-prize.entity';
import { SpinToken } from './spin-token.entity';

@Entity('spin_result')
export class SpinResult {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'spin_token_id', type: 'uuid', unique: true })
  spinTokenId: string;

  @OneToOne(() => SpinToken, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'spin_token_id' })
  spinToken: SpinToken;

  @Column({ name: 'prize_id', type: 'uuid' })
  prizeId: string;

  @ManyToOne(() => SpinPrize, (spinPrize) => spinPrize.spinResults, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'prize_id' })
  prize: SpinPrize;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
