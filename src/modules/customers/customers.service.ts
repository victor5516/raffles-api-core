import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike, In } from 'typeorm';
import { Customer } from './entities/customer.entity';
import { Purchase } from '../purchases/entities/purchase.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { Raffle } from '../raffles/entities/raffle.entity';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { S3Service } from '../../common/s3/s3.service';

@Injectable()
export class CustomersService {
  constructor(
    @InjectRepository(Customer)
    private customerRepository: Repository<Customer>,
    @InjectRepository(Purchase)
    private purchaseRepository: Repository<Purchase>,
    @InjectRepository(Ticket)
    private ticketRepository: Repository<Ticket>,
    private s3Service: S3Service,
  ) {}

  async findAll(query: Record<string, unknown>) {
    const nationalId =
      typeof query.nationalId === 'string' ? query.nationalId : undefined;
    const phone = typeof query.phone === 'string' ? query.phone : undefined;
    const fullName =
      typeof query.fullName === 'string' ? query.fullName : undefined;

    const pageRaw = query.page;
    const limitRaw = query.limit;
    const page =
      typeof pageRaw === 'string' || typeof pageRaw === 'number'
        ? Math.max(1, Number(pageRaw))
        : 1;
    const limit =
      typeof limitRaw === 'string' || typeof limitRaw === 'number'
        ? Math.max(1, Number(limitRaw))
        : 10;

    const skip = (page - 1) * limit;

    const qb = this.customerRepository
      .createQueryBuilder('customer')
      .orderBy('customer.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    if (nationalId) {
      qb.andWhere('customer.nationalId ILIKE :nationalId', {
        nationalId: `%${nationalId}%`,
      });
    }
    if (phone) {
      qb.andWhere('customer.phone ILIKE :phone', {
        phone: `%${phone}%`,
      });
    }
    if (fullName) {
      qb.andWhere('customer.fullName ILIKE :fullName', {
        fullName: `%${fullName}%`,
      });
    }

    const [customers, total] = await qb.getManyAndCount();

    return {
      data: customers,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(uid: string) {
    const customer = await this.customerRepository.findOne({
      where: { uid },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    // Get all purchases for this customer with raffle relation
    // Select ticketNumbers explicitly to ensure it's loaded
    const purchases = await this.purchaseRepository.find({
      where: { customerId: uid },
      relations: ['raffle'],
      select: {
        uid: true,
        raffleId: true,
        customerId: true,
        ticketQuantity: true,
        totalAmount: true,
        status: true,
        submittedAt: true,
        verifiedAt: true,
        ticketNumbers: true,
        raffle: {
          uid: true,
          title: true,
          description: true,
          ticketPrice: true,
          totalTickets: true,
          deadline: true,
          status: true,
          imageUrl: true,
          createdAt: true,
        },
      },
      order: { submittedAt: 'DESC' },
    });

    // Group purchases by raffleId
    const rafflesMap = new Map<string, { raffle: Raffle; purchases: Purchase[] }>();

    for (const purchase of purchases) {
      const raffleId = purchase.raffleId;
      if (!rafflesMap.has(raffleId)) {
        rafflesMap.set(raffleId, {
          raffle: purchase.raffle,
          purchases: [],
        });
      }
      rafflesMap.get(raffleId)!.purchases.push(purchase);
    }

    // Get all tickets for this customer's purchases, grouped by raffle
    const purchaseIds = purchases.map((p) => p.uid);
    const tickets = purchaseIds.length > 0
      ? await this.ticketRepository.find({
          where: { purchaseId: In(purchaseIds) },
          order: { ticketNumber: 'ASC' },
        })
      : [];

    // Group tickets by purchaseId, then by raffleId
    const ticketsByPurchase = new Map<string, Ticket[]>();
    for (const ticket of tickets) {
      if (!ticket.purchaseId) continue;
      if (!ticketsByPurchase.has(ticket.purchaseId)) {
        ticketsByPurchase.set(ticket.purchaseId, []);
      }
      ticketsByPurchase.get(ticket.purchaseId)!.push(ticket);
    }

    // Get presigned URLs for all unique raffle images
    const uniqueRaffles = Array.from(rafflesMap.values()).map(({ raffle }) => raffle);
    const raffleImageUrls = await Promise.all(
      uniqueRaffles.map((raffle) =>
        this.s3Service.getPresignedGetUrl(raffle.imageUrl).then(
          (presignedUrl) => ({
            raffleId: raffle.uid,
            imageUrl: presignedUrl ?? raffle.imageUrl,
          }),
        ),
      ),
    );
    const imageUrlMap = new Map(
      raffleImageUrls.map((item) => [item.raffleId, item.imageUrl]),
    );

    // Build response structure
    const rafflesData = Array.from(rafflesMap.values()).map(({ raffle, purchases: rafflePurchases }) => {
      // Get all tickets for purchases in this raffle
      const raffleTickets = rafflePurchases.flatMap((purchase) => {
        const purchaseTickets = ticketsByPurchase.get(purchase.uid) || [];
        // Also include tickets from ticketNumbers array if they exist
        const ticketNumbers = purchase.ticketNumbers || [];
        const ticketsFromArray = ticketNumbers.map((ticketNumber) => {
          // Find if there's already a ticket entity for this number
          const existingTicket = purchaseTickets.find(
            (t) => t.ticketNumber === ticketNumber && t.raffleId === raffle.uid,
          );
          if (existingTicket) {
            return existingTicket;
          }
          // Otherwise create a virtual ticket object
          return {
            uid: `${purchase.uid}-${ticketNumber}`,
            ticketNumber,
            raffleId: raffle.uid,
            purchaseId: purchase.uid,
            assignedAt: purchase.verifiedAt || purchase.submittedAt,
          };
        });
        // Merge and deduplicate
        const allTickets = [...purchaseTickets, ...ticketsFromArray];
        const uniqueTickets = Array.from(
          new Map(allTickets.map((t) => [t.ticketNumber, t])).values(),
        );
        return uniqueTickets;
      });

      return {
        raffle: {
          uid: raffle.uid,
          title: raffle.title,
          description: raffle.description,
          ticketPrice: raffle.ticketPrice,
          totalTickets: raffle.totalTickets,
          deadline: raffle.deadline,
          status: raffle.status,
          imageUrl: imageUrlMap.get(raffle.uid) ?? raffle.imageUrl,
          createdAt: raffle.createdAt,
        },
        tickets: raffleTickets.map((t) => ({
          uid: t.uid,
          ticketNumber: t.ticketNumber,
          assignedAt: t.assignedAt,
          purchaseId: t.purchaseId,
        })),
        purchaseCount: rafflePurchases.length,
      };
    });

    return {
      ...customer,
      raffles: rafflesData,
    };
  }

  async update(uid: string, updateDto: UpdateCustomerDto) {
    const customer = await this.customerRepository.findOne({
      where: { uid },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    // Check email uniqueness if email is being updated
    if (updateDto.email && updateDto.email !== customer.email) {
      const existingCustomer = await this.customerRepository.findOne({
        where: { email: updateDto.email },
      });

      if (existingCustomer && existingCustomer.uid !== uid) {
        throw new ConflictException('Email already exists');
      }
    }

    // Update fields
    if (updateDto.fullName !== undefined) {
      customer.fullName = updateDto.fullName;
    }
    if (updateDto.email !== undefined) {
      customer.email = updateDto.email;
    }
    if (updateDto.phone !== undefined) {
      customer.phone = updateDto.phone;
    }

    return await this.customerRepository.save(customer);
  }
}
