import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ReconciliationResult } from '../dto/reconciliation.dto';
import { Raffle } from '../../raffles/entities/raffle.entity';

export enum ReconciliationJobStatus {
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

@Entity('reconciliation_jobs')
export class ReconciliationJob {
  @PrimaryGeneratedColumn('uuid')
  uid: string;

  @Column({ name: 'raffle_id', nullable: true })
  raffleId: string | null;

  @ManyToOne(() => Raffle, { nullable: true })
  @JoinColumn({ name: 'raffle_id' })
  raffle?: Raffle;

  @Column({ name: 'payment_method_id' })
  paymentMethodId: string;

  @Column({ name: 'file_name', nullable: true })
  fileName: string | null;

  @Column({ name: 'file_mime_type', nullable: true })
  fileMimeType: string | null;

  @Column({
    type: 'enum',
    enum: ReconciliationJobStatus,
    default: ReconciliationJobStatus.PROCESSING,
  })
  status: ReconciliationJobStatus;

  /** Resultado completo de la conciliación — null hasta que status=ready */
  @Column({ type: 'jsonb', nullable: true })
  result: ReconciliationResult | null;

  /** Mensaje de error — null salvo que status=failed */
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  /** Admin que inició el job */
  @Column({ name: 'created_by', nullable: true })
  createdBy: string | null;

  /** Para detectar jobs colgados si el proceso reinicia */
  @Column({ name: 'started_at', type: 'timestamp', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
