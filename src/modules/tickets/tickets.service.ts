import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Purchase, PurchaseStatus } from '../purchases/entities/purchase.entity';
import { Raffle, RaffleStatus } from '../raffles/entities/raffle.entity';
import { S3Service } from '../../common/s3/s3.service';

@Injectable()
export class TicketsService {
  constructor(
    @InjectRepository(Purchase)
    private purchaseRepository: Repository<Purchase>,
    @InjectRepository(Raffle)
    private raffleRepository: Repository<Raffle>,
    private readonly s3Service: S3Service,
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

  async findByNationalId(nationalId: string) {
    if (!nationalId) {
      throw new BadRequestException('national_id is required');
    }

    // Find all purchases for this customer in active raffles using query builder
    const purchases = await this.purchaseRepository
      .createQueryBuilder('purchase')
      .innerJoin('purchase.customer', 'customer')
      .innerJoin('purchase.raffle', 'raffle')
      .where('customer.nationalId = :nationalId', { nationalId })
      .andWhere('raffle.status = :status', { status: RaffleStatus.ACTIVE })
      .select([
        'purchase.uid',
        'purchase.ticketNumbers',
        'purchase.status',
        'purchase.submittedAt',
        'purchase.verifiedAt',
        'raffle.uid',
        'raffle.title',
        'raffle.description',
        'raffle.ticketPrice',
        'raffle.totalTickets',
        'raffle.imageUrl',
        'raffle.status',
      ])
      .getMany();

    if (purchases.length === 0) {
      return { raffles: [] };
    }

    // Group purchases by raffle
    const raffleMap = new Map<string, {
      raffle: any;
      purchases: number;
      tickets: Array<{
        ticketNumber: number;
        status: PurchaseStatus;
        purchaseDate: Date;
      }>;
    }>();

    purchases.forEach((purchase) => {
      const raffleId = purchase.raffle.uid;

      if (!raffleMap.has(raffleId)) {
        raffleMap.set(raffleId, {
          raffle: {
            uid: purchase.raffle.uid,
            title: purchase.raffle.title,
            description: purchase.raffle.description,
            ticketPrice: purchase.raffle.ticketPrice,
            totalTickets: purchase.raffle.totalTickets,
            imageUrl: purchase.raffle.imageUrl,
            status: purchase.raffle.status,
          },
          purchases: 0,
          tickets: [],
        });
      }

      const raffleData = raffleMap.get(raffleId)!;
      raffleData.purchases += 1;

      // Add all tickets from this purchase
      if (purchase.ticketNumbers && purchase.ticketNumbers.length > 0) {
        purchase.ticketNumbers.forEach((ticketNumber) => {
          raffleData.tickets.push({
            ticketNumber,
            status: purchase.status,
            purchaseDate: purchase.verifiedAt || purchase.submittedAt,
          });
        });
      }
    });

    // Convert map to array and sort tickets by number
    const rafflesArray = Array.from(raffleMap.values()).map((raffleData) => ({
      ...raffleData,
      tickets: raffleData.tickets.sort((a, b) => a.ticketNumber - b.ticketNumber),
    }));

    // Generate presigned URLs for all raffle images
    const rafflesWithPresignedUrls = await Promise.all(
      rafflesArray.map(async (raffleData) => {
        const presignedImageUrl =
          (await this.s3Service.getPresignedGetUrl(raffleData.raffle.imageUrl)) ??
          raffleData.raffle.imageUrl;

        return {
          ...raffleData,
          raffle: {
            ...raffleData.raffle,
            imageUrl: presignedImageUrl,
          },
        };
      }),
    );

    return { raffles: rafflesWithPresignedUrls };
  }
}
