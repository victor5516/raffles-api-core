import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Customer } from './entities/customer.entity';
import { Purchase } from '../purchases/entities/purchase.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { Raffle } from '../raffles/entities/raffle.entity';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ToggleBlacklistDto } from './dto/toggle-blacklist.dto';
import { trimCustomerData } from './utils/trim-customer-data';
import { S3Service } from '../../common/s3/s3.service';
import { AuditEventPayload } from '../audit-logs/dto/audit-event.payload';

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
    private readonly eventEmitter: EventEmitter2,
    private readonly dataSource: DataSource,
  ) {}

  private buildCustomersQuery(query: Record<string, unknown>) {
    const nationalId =
      typeof query.nationalId === 'string' ? query.nationalId : undefined;
    const phone = typeof query.phone === 'string' ? query.phone : undefined;
    const fullName =
      typeof query.fullName === 'string' ? query.fullName : undefined;
    const isBlacklisted =
      typeof query.isBlacklisted === 'string' ? query.isBlacklisted : undefined;

    const qb = this.customerRepository
      .createQueryBuilder('customer')
      .orderBy('customer.createdAt', 'DESC');

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
    if (isBlacklisted !== undefined) {
      const blacklisted = isBlacklisted === 'true';
      qb.andWhere('customer.isBlacklisted = :isBlacklisted', {
        isBlacklisted: blacklisted,
      });
    }

    return qb;
  }

  async findAll(query: Record<string, unknown>) {
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

    const qb = this.buildCustomersQuery(query).skip(skip).take(limit);

    const [customers, total] = await qb.getManyAndCount();

    return {
      data: customers,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async exportCustomersExcel(query: Record<string, unknown>): Promise<Buffer> {
    const customers = await this.buildCustomersQuery(query).getMany();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Raffles Admin';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Clientes');
    worksheet.columns = [
      { header: 'Fecha Registro', key: 'createdAt', width: 18 },
      { header: 'Cedula', key: 'nationalId', width: 18 },
      { header: 'Nombre', key: 'fullName', width: 30 },
      { header: 'Email', key: 'email', width: 32 },
      { header: 'Telefono', key: 'phone', width: 18 },
      { header: 'Estado', key: 'status', width: 14 },
      { header: 'Motivo Bloqueo', key: 'blacklistReason', width: 30 },
      { header: 'Fecha Bloqueo', key: 'blacklistedAt', width: 18 },
      { header: 'Estado', key: 'state', width: 20 },
      { header: 'Ciudad', key: 'city', width: 20 },
      { header: 'Direccion', key: 'address', width: 36 },
      { header: 'ZIP', key: 'zip', width: 12 },
    ];
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    customers.forEach((customer) => {
      const location =
        (customer.location as Record<string, string> | null) ?? {};
      worksheet.addRow({
        createdAt: customer.createdAt
          ? new Date(customer.createdAt).toLocaleDateString('es-VE')
          : '-',
        nationalId: customer.nationalId,
        fullName: customer.fullName,
        email: customer.email,
        phone: customer.phone ?? '-',
        status: customer.isBlacklisted ? 'Bloqueado' : 'Activo',
        blacklistReason: customer.blacklistReason ?? '-',
        blacklistedAt: customer.blacklistedAt
          ? new Date(customer.blacklistedAt).toLocaleDateString('es-VE')
          : '-',
        state: location.state ?? '-',
        city: location.city ?? '-',
        address: location.address ?? '-',
        zip: location.zip ?? '-',
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
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
    const rafflesMap = new Map<
      string,
      { raffle: Raffle; purchases: Purchase[] }
    >();

    for (const purchase of purchases) {
      const raffleId = purchase.raffleId;
      if (!rafflesMap.has(raffleId)) {
        rafflesMap.set(raffleId, {
          raffle: purchase.raffle,
          purchases: [],
        });
      }
      rafflesMap.get(raffleId).purchases.push(purchase);
    }

    // Get all tickets for this customer's purchases, grouped by raffle
    const purchaseIds = purchases.map((p) => p.uid);
    const tickets =
      purchaseIds.length > 0
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
      ticketsByPurchase.get(ticket.purchaseId).push(ticket);
    }

    // Presigned GET URLs for unique raffle images
    const uniqueRaffles = Array.from(rafflesMap.values()).map(
      ({ raffle }) => raffle,
    );
    const raffleImageUrls = await Promise.all(
      uniqueRaffles.map(async (raffle) => ({
        raffleId: raffle.uid,
        imageUrl:
          (await this.s3Service.getPresignedGetUrl(raffle.imageUrl)) ??
          raffle.imageUrl,
      })),
    );
    const imageUrlMap = new Map(
      raffleImageUrls.map((item) => [item.raffleId, item.imageUrl]),
    );

    // Build response structure
    const rafflesData = Array.from(rafflesMap.values()).map(
      ({ raffle, purchases: rafflePurchases }) => {
        // Get all tickets for purchases in this raffle
        const raffleTickets = rafflePurchases.flatMap((purchase) => {
          const purchaseTickets = ticketsByPurchase.get(purchase.uid) || [];
          // Also include tickets from ticketNumbers array if they exist
          const ticketNumbers = purchase.ticketNumbers || [];
          const ticketsFromArray = ticketNumbers.map((ticketNumber) => {
            // Find if there's already a ticket entity for this number
            const existingTicket = purchaseTickets.find(
              (t) =>
                t.ticketNumber === ticketNumber && t.raffleId === raffle.uid,
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
      },
    );

    return {
      ...customer,
      raffles: rafflesData,
    };
  }

  async update(uid: string, updateDto: UpdateCustomerDto, adminId: string) {
    const dto = trimCustomerData({
      ...updateDto,
    } as Record<string, unknown>) as UpdateCustomerDto;

    const oldData = await this.findOne(uid);

    const customer = await this.customerRepository.findOne({
      where: { uid },
    });

    // Check nationalId uniqueness if nationalId is being updated
    if (dto.nationalId && dto.nationalId !== customer.nationalId) {
      const existingCustomer = await this.customerRepository.findOne({
        where: { nationalId: dto.nationalId },
      });

      if (existingCustomer && existingCustomer.uid !== uid) {
        throw new ConflictException('La cédula ya está en uso');
      }
    }

    // Check email uniqueness if email is being updated
    if (dto.email && dto.email !== customer.email) {
      const existingCustomer = await this.customerRepository.findOne({
        where: { email: dto.email },
      });

      if (existingCustomer && existingCustomer.uid !== uid) {
        throw new ConflictException('Email already exists');
      }
    }

    // Update fields
    if (dto.nationalId !== undefined) {
      customer.nationalId = dto.nationalId;
    }
    if (dto.fullName !== undefined) {
      customer.fullName = dto.fullName;
    }
    if (dto.email !== undefined) {
      customer.email = dto.email;
    }
    if (dto.phone !== undefined) {
      customer.phone = dto.phone;
    }
    if (dto.location !== undefined) {
      customer.location = dto.location as Record<string, any>;
    }

    await this.customerRepository.save(customer);
    const newData = await this.findOne(uid);

    this.eventEmitter.emit('audit.log', {
      adminId,
      action: 'UPDATE',
      entityName: 'Customer',
      entityId: uid,
      previousData: oldData,
      newData,
    } satisfies AuditEventPayload);

    return newData;
  }

  async toggleBlacklist(uid: string, dto: ToggleBlacklistDto, adminId: string) {
    const oldData = await this.findOne(uid);

    const customer = await this.customerRepository.findOne({
      where: { uid },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    customer.isBlacklisted = dto.isBlacklisted;
    customer.blacklistReason = dto.isBlacklisted ? (dto.reason ?? null) : null;
    customer.blacklistedAt = dto.isBlacklisted ? new Date() : null;

    await this.customerRepository.save(customer);
    const newData = await this.findOne(uid);

    this.eventEmitter.emit('audit.log', {
      adminId,
      action: 'UPDATE',
      entityName: 'Customer',
      entityId: uid,
      previousData: oldData,
      newData,
    } satisfies AuditEventPayload);

    return newData;
  }

  async mergeCustomers(sourceId: string, targetId: string, adminId: string) {
    if (sourceId === targetId) {
      throw new BadRequestException(
        'sourceId y targetId no pueden ser el mismo cliente',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const [sourceCustomer, targetCustomer] = await Promise.all([
        manager.findOne(Customer, { where: { uid: sourceId } }),
        manager.findOne(Customer, { where: { uid: targetId } }),
      ]);

      if (!sourceCustomer) {
        throw new NotFoundException(
          `Cliente origen (${sourceId}) no encontrado`,
        );
      }

      if (!targetCustomer) {
        throw new NotFoundException(
          `Cliente destino (${targetId}) no encontrado`,
        );
      }

      await manager.update(
        Purchase,
        { customerId: sourceId },
        { customerId: targetId },
      );

      await manager.remove(Customer, sourceCustomer);

      this.eventEmitter.emit('audit.log', {
        adminId,
        action: 'DELETE',
        entityName: 'Customer',
        entityId: sourceId,
        previousData: sourceCustomer,
        newData: { mergedInto: targetId },
      } satisfies AuditEventPayload);

      return {
        message: 'Clientes fusionados exitosamente',
        deletedCustomerId: sourceId,
        targetCustomerId: targetId,
      };
    });
  }
}
