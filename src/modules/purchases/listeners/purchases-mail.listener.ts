import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Purchase, PurchaseStatus } from '../entities/purchase.entity';
import { MailService } from '../../mail/mail.service';

interface PurchaseCreatedEvent {
  type: string;
  msg: string;
  raffleId: string;
  purchaseId: string;
}

interface PurchaseStatusChangedEvent {
  type: string;
  msg: string;
  raffleId: string;
  purchaseId: string;
  status: PurchaseStatus;
}

@Injectable()
export class PurchasesMailListener {
  private readonly logger = new Logger(PurchasesMailListener.name);

  constructor(
    @InjectRepository(Purchase)
    private readonly purchaseRepository: Repository<Purchase>,
    private readonly mailService: MailService,
  ) {}

  @OnEvent('purchase.created')
  async handlePurchaseCreated(event: PurchaseCreatedEvent) {
    try {
      const purchase = await this.purchaseRepository.findOne({
        where: { uid: event.purchaseId },
        relations: ['customer', 'raffle'],
      });

      if (!purchase || !purchase.customer) {
        this.logger.warn(
          `Purchase ${event.purchaseId} or customer not found, skipping email`,
        );
        return;
      }

      await this.mailService.sendPurchaseCreated(purchase, purchase.customer);
    } catch (error) {
      // Log error but don't throw to avoid interrupting the purchase flow
      this.logger.error(
        `Failed to send purchase created email for ${event.purchaseId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  @OnEvent('purchase.status_changed')
  async handlePurchaseStatusChanged(event: PurchaseStatusChangedEvent) {
    try {
      const purchase = await this.purchaseRepository.findOne({
        where: { uid: event.purchaseId },
        relations: ['customer', 'raffle'],
      });

      if (!purchase || !purchase.customer) {
        this.logger.warn(
          `Purchase ${event.purchaseId} or customer not found, skipping email`,
        );
        return;
      }

      // Send appropriate email based on status
      if (event.status === PurchaseStatus.VERIFIED) {
        await this.mailService.sendPurchaseVerified(
          purchase,
          purchase.customer,
        );
      } else if (event.status === PurchaseStatus.REJECTED) {
        await this.mailService.sendPurchaseRejected(
          purchase,
          purchase.customer,
        );
      }
      // Other statuses (MANUAL_REVIEW, DUPLICATED) don't trigger emails
    } catch (error) {
      // Log error but don't throw to avoid interrupting the status update flow
      this.logger.error(
        `Failed to send status changed email for ${event.purchaseId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
