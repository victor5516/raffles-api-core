import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Raffle } from '../../raffles/entities/raffle.entity';
import { Purchase } from '../../purchases/entities/purchase.entity';

@Entity('ticket')
@Unique(['raffleId', 'ticketNumber'])
export class Ticket {
  @PrimaryGeneratedColumn('uuid')
  uid: string;

  @Column({ name: 'raffle_id' })
  raffleId: string;

  @ManyToOne(() => Raffle, (raffle) => raffle.tickets)
  @JoinColumn({ name: 'raffle_id' })
  raffle: Raffle;

  @Column({ name: 'purchase_id', nullable: true })
  purchaseId: string;

  @ManyToOne(() => Purchase, (purchase) => purchase.tickets)
  @JoinColumn({ name: 'purchase_id' })
  purchase: Purchase;

  @Column({ name: 'ticket_number' })
  ticketNumber: number;

  @CreateDateColumn({ name: 'assigned_at' })
  assignedAt: Date;
}
