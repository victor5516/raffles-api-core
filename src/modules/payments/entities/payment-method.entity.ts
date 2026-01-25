import { Entity, Column, PrimaryGeneratedColumn, OneToMany, ManyToOne, JoinColumn } from 'typeorm';
import { Purchase } from '../../purchases/entities/purchase.entity';
import { Currency } from '../../currencies/entities/currency.entity';

@Entity('payment_method')
export class PaymentMethod {
  @PrimaryGeneratedColumn('uuid')
  uid: string;

  @Column({ unique: true })
  name: string;

  @Column({ name: 'account_holder_name', nullable: true })
  accountHolderName: string;

  @Column({ name: 'image_url', nullable: true })
  imageUrl: string;

  @Column({ name: 'payment_data', type: 'jsonb' })
  paymentData: any;

  @Column({ name: 'minimum_payment_amount', type: 'decimal' })
  minimumPaymentAmount: number;

  @Column({ name: 'currency_id', type: 'uuid' })
  currencyId: string;

  @ManyToOne(() => Currency, { eager: true })
  @JoinColumn({ name: 'currency_id' })
  currency: Currency;
  @Column({ name: 'external_id', nullable: true })
  externalId: string;

  @OneToMany(() => Purchase, (purchase) => purchase.paymentMethod)
  purchases: Purchase[];
}
