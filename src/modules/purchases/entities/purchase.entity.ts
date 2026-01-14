import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Raffle } from '../../raffles/entities/raffle.entity';
import { Customer } from '../../customers/entities/customer.entity';
import { PaymentMethod } from '../../payments/entities/payment-method.entity';
import { Ticket } from '../../tickets/entities/ticket.entity';

export enum PurchaseStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
}

@Entity('purchase')
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

  @Column({ name: 'payment_screenshot_url' })
  paymentScreenshotUrl: string;

  @Column({ name: 'bank_reference' })
  bankReference: string;

  @Column({
    type: 'enum',
    enum: PurchaseStatus,
    default: PurchaseStatus.PENDING,
  })
  status: PurchaseStatus;

  @CreateDateColumn({ name: 'submitted_at' })
  submittedAt: Date;

  @Column({ name: 'verified_at', nullable: true })
  verifiedAt: Date;

  @OneToMany(() => Ticket, (ticket) => ticket.purchase)
  tickets: Ticket[];
}
