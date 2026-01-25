import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { Purchase } from '../../purchases/entities/purchase.entity';
import { Ticket } from '../../tickets/entities/ticket.entity';

export enum RaffleStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  CLOSED = 'closed',
}

export enum RaffleSelectionType {
  RANDOM = 'random',
  SPECIFIC = 'specific',
}

@Entity('raffle')
export class Raffle {
  @PrimaryGeneratedColumn('uuid')
  uid: string;

  @Column()
  title: string;

  @Column({ nullable: true, type: 'text' })
  description: string;

  @Column({ name: 'digits_length', nullable: true })
  digitsLength: number;

  @Column({ name: 'ticket_price', type: 'decimal' })
  ticketPrice: number;

  @Column({ name: 'total_tickets' })
  totalTickets: number;

  @Column({ name: 'min_tickets_per_purchase', default: 1})
  minTicketsPerPurchase: number;

  @Column({ name: 'image_url', nullable: true })
  imageUrl: string;

  @Column()
  deadline: Date;

  @Column({
    type: 'enum',
    enum: RaffleStatus,
    default: RaffleStatus.DRAFT,
  })
  status: RaffleStatus;

  @Column({
    type: 'enum',
    enum: RaffleSelectionType,
    default: RaffleSelectionType.RANDOM,
    name: 'selection_type',
  })
  selectionType: RaffleSelectionType;

  @Column({name: 'external_id', nullable: true})
  externalId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => Purchase, (purchase) => purchase.raffle)
  purchases: Purchase[];

  @OneToMany(() => Ticket, (ticket) => ticket.raffle)
  tickets: Ticket[];
}
