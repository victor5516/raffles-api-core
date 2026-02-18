import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { Raffle } from '../../raffles/entities/raffle.entity';
import { Customer } from '../../customers/entities/customer.entity';
import { PaymentMethod } from '../../payments/entities/payment-method.entity';
import { Ticket } from '../../tickets/entities/ticket.entity';
import { Admin } from '../../auth/entities/admin.entity';

export interface PaymentEntry {
  amount: number;
  reference: string;
  currency: string;
  evidenceUrl: string;
  verified: boolean;
  aiResult?: any;
  reviewedBy?: string;
  paymentMethodId?: string;
  paymentMethodName?: string;
}

export enum PurchaseStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
  MANUAL_REVIEW = 'manual_review',
  DUPLICATED = 'duplicated',
}

export enum VerificationSource {
  AI = 'ai',
  ADMIN = 'admin',
  BY_SYSTEM = 'by_system',
}

@Entity('purchase')
@Index('purchase_raffle_tickets_gin_idx', ['raffleId', 'ticketNumbers'], {
  using: 'gin',
} as any)
export class Purchase {
  @PrimaryGeneratedColumn('uuid')
  uid: string;

  @Column({ name: 'raffle_id' })
  raffleId: string;

  @ManyToOne(() => Raffle, (raffle) => raffle.purchases)
  @JoinColumn({ name: 'raffle_id' })
  raffle: Raffle;

  @Column({ name: 'customer_id' })
  customerId: string;

  @ManyToOne(() => Customer, (customer) => customer.purchases)
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;

  @Column({ name: 'payment_method_id' })
  paymentMethodId: string;

  @ManyToOne(() => PaymentMethod, (pm) => pm.purchases)
  @JoinColumn({ name: 'payment_method_id' })
  paymentMethod: PaymentMethod;

  @Column({ name: 'ticket_quantity' })
  ticketQuantity: number;

  /** @deprecated Use payments[].evidenceUrl instead */
  @Column({ name: 'payment_screenshot_url' })
  paymentScreenshotUrl: string;

  /** @deprecated Use payments[].reference instead */
  @Column({ name: 'bank_reference' })
  bankReference: string;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes: string;

  @Column({
    type: 'enum',
    enum: PurchaseStatus,
    default: PurchaseStatus.PENDING,
  })
  status: PurchaseStatus;

  @Column({
    name: 'total_amount',
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
  })
  totalAmount: number;

  @Column({ type: 'jsonb', nullable: true, name: 'ai_analysis_result' })
  aiAnalysisResult: any;

  @CreateDateColumn({ name: 'submitted_at' })
  submittedAt: Date;

  @Column({ name: 'verified_at', nullable: true })
  verifiedAt: Date;

  @Column({
    type: 'enum',
    enum: VerificationSource,
    nullable: true,
    name: 'verification_source',
  })
  verificationSource?: VerificationSource;

  @ManyToOne(() => Admin, { nullable: true })
  @JoinColumn({ name: 'verified_by_admin_id' })
  verifiedByAdmin?: Admin;

  @Column({ name: 'audit_reviewed_at', type: 'timestamp', nullable: true })
  auditReviewedAt: Date | null;

  @Column('integer', { array: true, nullable: true, name: 'ticket_numbers' })
  ticketNumbers: number[];

  @OneToMany(() => Ticket, (ticket) => ticket.purchase)
  tickets: Ticket[];

  @Column({ name: 'exported_to_sheets', type: 'boolean', default: false })
  exportedToSheets: boolean;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  payments: PaymentEntry[];

  @Column({
    name: 'total_paid',
    type: 'numeric',
    precision: 10,
    scale: 2,
    default: 0,
  })
  totalPaid: number;
}
