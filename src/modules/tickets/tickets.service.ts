import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ticket } from './entities/ticket.entity';

@Injectable()
export class TicketsService {
  constructor(
    @InjectRepository(Ticket)
    private ticketRepository: Repository<Ticket>,
  ) {}

  async search(nationalId: string, raffleUid: string) {
    if (!nationalId || !raffleUid) {
      throw new BadRequestException('national_id and raffle_uid are required');
    }

    const tickets = await this.ticketRepository.find({
      where: {
        raffleId: raffleUid,
        purchase: {
          customer: {
            nationalId: nationalId,
          },
        },
      },
      relations: ['purchase', 'purchase.customer'],
      order: { ticketNumber: 'ASC' },
    });

    return tickets.map((ticket) => ({
      id: ticket.uid,
      ticket_number: ticket.ticketNumber.toString(),
      customer_name: ticket.purchase?.customer?.fullName || 'N/A',
      customer_national_id: ticket.purchase?.customer?.nationalId || 'N/A',
      purchase_date: ticket.assignedAt.toISOString(),
      status: ticket.purchase?.status || 'active',
    }));
  }
}
