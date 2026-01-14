import { Entity, Column, PrimaryGeneratedColumn, OneToMany } from 'typeorm';
import { Purchase } from '../../purchases/entities/purchase.entity';

export enum CurrencyType {
  USD = 'USD',
  VES = 'VES',
}

@Entity('payment_method')
export class PaymentMethod {
  @PrimaryGeneratedColumn('uuid')
  uid: string;

  @Column({ unique: true })
  name: string;

  @Column({ name: 'image_url', nullable: true })
  imageUrl: string;

  @Column({ name: 'payment_data', type: 'jsonb' })
  paymentData: any;

  @Column({ name: 'minimum_payment_amount', type: 'decimal' })
  minimumPaymentAmount: number;

  @Column({ type: 'enum', enum: CurrencyType })
  currency: CurrencyType;

  @OneToMany(() => Purchase, (purchase) => purchase.paymentMethod)
  purchases: Purchase[];
}
