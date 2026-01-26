import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Purchase, PurchaseStatus } from '../purchases/entities/purchase.entity';

@Injectable()
export class TicketsService {
  constructor(
    @InjectRepository(Purchase)
    private purchaseRepository: Repository<Purchase>,
  ) {}

  async search(nationalId: string, raffleUid: string) {
    if (!nationalId || !raffleUid) {
      throw new BadRequestException('national_id and raffle_uid are required');
    }

    const purchases = await this.purchaseRepository.find({
      where: {
        raffleId: raffleUid,
        status: PurchaseStatus.VERIFIED,
        customer: {
          nationalId: nationalId,
        },
      },
      relations: ['customer'],
      select: {
        uid: true,
        ticketNumbers: true,
        status: true,
        verifiedAt: true,
        submittedAt: true,
        customer: {
          fullName: true,
          nationalId: true,
        },
      },
    });

    const allTickets = purchases.flatMap((purchase) =>
      (purchase.ticketNumbers || []).map((num) => ({
        id: `${purchase.uid}-${num}`,
        ticket_number: num.toString(),
        customer_name: purchase.customer?.fullName || 'N/A',
        customer_national_id: purchase.customer?.nationalId || 'N/A',
        purchase_date:
          purchase.verifiedAt?.toISOString() ||
          purchase.submittedAt.toISOString(),
        status: purchase.status,
      })),
    );

    return allTickets.sort(
      (a, b) => Number(a.ticket_number) - Number(b.ticket_number),
    );
  }

  async getTakenTickets(raffleId: string): Promise<number[]> {
    const purchases = await this.purchaseRepository.find({
      where: {
        raffleId,
        status: In([
          PurchaseStatus.PENDING,
          PurchaseStatus.VERIFIED,
          PurchaseStatus.MANUAL_REVIEW,
        ]),
      },
      select: ['ticketNumbers'],
    });

    const allTicketNumbers = purchases
      .flatMap((purchase) => purchase.ticketNumbers || [])
      .filter((num) => num !== null && num !== undefined);

    return Array.from(new Set(allTicketNumbers)).sort((a, b) => a - b);
  }
}
