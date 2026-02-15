import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Raffle, RaffleSelectionType } from '../../raffles/entities/raffle.entity';
import { Purchase, PurchaseStatus } from '../entities/purchase.entity';
import { CreatePurchaseDto } from '../dto/create-purchase.dto';

@Injectable()
export class TicketAllocationService {
  /**
   * Determines how tickets are allocated based on Raffle type.
   * SPECIFIC: validates and returns the requested numbers.
   * RANDOM: only validates capacity and returns null (to be assigned later).
   */
  async determineAllocationStrategy(
    manager: EntityManager,
    raffle: Raffle,
    dto: CreatePurchaseDto,
  ): Promise<number[] | null> {
    if (raffle.selectionType === RaffleSelectionType.SPECIFIC) {
      return this.validateSpecificSelection(
        manager,
        raffle,
        dto.ticket_numbers,
        dto.ticket_quantity,
      );
    }

    await this.ensureRandomAvailability(
      manager,
      raffle,
      dto.ticket_quantity,
    );
    return null; // Will be assigned later in assignRandomNumbers
  }

  /**
   * Validates specific ticket selection.
   * Checks range, duplicates, and availability against DB (Pending or Verified).
   */
  async validateSpecificSelection(
    manager: EntityManager,
    raffle: Raffle,
    numbers: number[] | undefined,
    quantity: number,
  ): Promise<number[]> {
    // 1. Input Validation
    if (!numbers || numbers.length === 0) {
      throw new BadRequestException(
        'ticket_numbers is required for SPECIFIC raffles',
      );
    }

    if (numbers.length !== quantity) {
      throw new BadRequestException(
        `Mismatch: quantity=${quantity} vs provided=${numbers.length}`,
      );
    }

    // 2. Range & Duplicate Check (In Memory)
    const uniqueRequested = new Set(numbers);
    if (uniqueRequested.size !== numbers.length) {
      throw new BadRequestException('ticket_numbers contains duplicates');
    }

    const invalid = numbers.filter(
      (n) => n < 0 || n >= raffle.totalTickets,
    );
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Invalid numbers (out of range): ${invalid.join(', ')}`,
      );
    }

    // 3. Database Availability Check
    const occupiedCount = await this.countOccupied(
      manager,
      raffle.uid,
      numbers,
    );

    if (occupiedCount > 0) {
      throw new ConflictException(
        'Some selected tickets are already reserved or verified.',
      );
    }

    return numbers;
  }

  /**
   * Validates capacity for random raffles.
   */
  async ensureRandomAvailability(
    manager: EntityManager,
    raffle: Raffle,
    quantity: number,
  ): Promise<void> {
    // Count ALL tickets currently occupied (Pending, Verified, or Manual Review)
    const result = await manager.query(
      `SELECT SUM(ticket_quantity) as total
         FROM purchase
         WHERE raffle_id = $1
         AND status IN ($2, $3, $4)`,
      [
        raffle.uid,
        PurchaseStatus.PENDING,
        PurchaseStatus.VERIFIED,
        PurchaseStatus.MANUAL_REVIEW,
      ],
    );

    const occupied = parseInt(result[0]?.total || '0', 10);
    const available = raffle.totalTickets - occupied;

    if (available < quantity) {
      throw new ConflictException(`Not enough tickets. Available: ${available}`);
    }
  }

  /**
   * Helper to count how many of the requested numbers are already taken.
   * Checks PENDING, VERIFIED, and MANUAL_REVIEW statuses.
   * @param excludePurchaseId - When provided (e.g. on update), excludes this purchase from the count.
   */
  async countOccupied(
    manager: EntityManager,
    raffleId: string,
    numbersToCheck: number[],
    excludePurchaseId?: string,
  ): Promise<number> {
    const params: (string | number | string[] | number[])[] = [
      raffleId,
      PurchaseStatus.PENDING,
      PurchaseStatus.VERIFIED,
      PurchaseStatus.MANUAL_REVIEW,
      numbersToCheck,
    ];
    const excludeClause = excludePurchaseId ? ' AND purchase.uid != $6' : '';
    if (excludePurchaseId) params.push(excludePurchaseId);

    const result = await manager.query(
      `SELECT COUNT(*) as count
       FROM purchase, unnest(ticket_numbers) as t_num
       WHERE purchase.raffle_id = $1
       AND purchase.status IN ($2, $3, $4)
       AND t_num = ANY($5)${excludeClause}`,
      params,
    );
    return parseInt(result[0]?.count || '0', 10);
  }

  /**
   * Assigns ticket numbers for RANDOM type raffles.
   * Ensures new random numbers do not collide with existing reserved or verified tickets.
   */
  async assignRandomNumbers(
    manager: EntityManager,
    raffleId: string,
    purchase: Purchase,
  ): Promise<void> {
    // If tickets are already assigned (SPECIFIC type), skip.
    if (purchase.ticketNumbers && purchase.ticketNumbers.length > 0) return;

    const raffle = await manager.findOne(Raffle, {
      where: { uid: raffleId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!raffle) throw new NotFoundException('Raffle not found');

    // Get SET of currently occupied numbers (Pending or Verified)
    // We must exclude the current purchase from the check (though it has no numbers yet)
    const takenTicketsRaw = await manager.query(
      `SELECT unnest("ticket_numbers") as num FROM purchase
       WHERE "raffle_id" = $1
       AND "ticket_numbers" IS NOT NULL
       AND "status" IN ($2, $3, $4)
       AND uid != $5`,
      [
        raffle.uid,
        PurchaseStatus.PENDING,
        PurchaseStatus.VERIFIED,
        PurchaseStatus.MANUAL_REVIEW,
        purchase.uid,
      ],
    );

    const soldSet = new Set<number>(
      takenTicketsRaw.map((s: { num: number }) => Number(s.num)),
    );
    const available = raffle.totalTickets - soldSet.size;

    if (available < purchase.ticketQuantity) {
      throw new ConflictException('Not enough tickets available.');
    }

    // Random Generation
    const toAssign: number[] = [];
    const maxAttempts = purchase.ticketQuantity * 10;
    let attempts = 0;

    while (
      toAssign.length < purchase.ticketQuantity &&
      attempts < maxAttempts
    ) {
      const randomNum = Math.floor(Math.random() * raffle.totalTickets);
      // Ensure no collision with SoldSet AND no duplicates within the current assignment batch
      if (!soldSet.has(randomNum) && !toAssign.includes(randomNum)) {
        toAssign.push(randomNum);
      }
      attempts++;
    }

    if (toAssign.length < purchase.ticketQuantity) {
      throw new ConflictException(
        'Could not assign tickets (congestion). Try again.',
      );
    }

    purchase.ticketNumbers = toAssign;
    await manager.save(Purchase, purchase);

    // Notification for specific assignment (optional, if needed for email/sms)
    // this.eventEmitter.emit(...)
  }
}

