import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Purchase, PurchaseStatus } from './entities/purchase.entity';
import { GoogleSheetsService } from '../../common/services/google-sheets.service';

const STATUS_LABELS: Record<string, string> = {
  [PurchaseStatus.PENDING]: 'Pendiente',
  [PurchaseStatus.VERIFIED]: 'Verificado',
  [PurchaseStatus.REJECTED]: 'Rechazado',
  [PurchaseStatus.MANUAL_REVIEW]: 'Revisión Manual',
  [PurchaseStatus.DUPLICATED]: 'Duplicado',
};

/** Sanitize payment method name for use as Google Sheet tab name (max 31 chars, no * ? : / \ [ ]). */
function toSheetName(name: string): string {
  return String(name ?? '')
    .trim()
    .slice(0, 31)
    .replace(/[*?:/\\[\]]/g, '-');
}

@Injectable()
export class PurchasesCron {
  private readonly logger = new Logger(PurchasesCron.name);
  private isRunning = false;

  constructor(
    @InjectRepository(Purchase)
    private readonly purchaseRepository: Repository<Purchase>,
    private readonly googleSheetsService: GoogleSheetsService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async exportPurchasesToSheets(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Export already in progress, skipping run');
      return;
    }

    const spreadsheetId = this.configService.get<string>('GOOGLE_SPREADSHEET_ID');
    if (!spreadsheetId) {
      this.logger.warn('GOOGLE_SPREADSHEET_ID not set, skipping export');
      return;
    }

    this.isRunning = true;
    try {
      const purchases = await this.purchaseRepository.find({
        where: {
          exportedToSheets: false,
          status: In([
            PurchaseStatus.PENDING,
            PurchaseStatus.VERIFIED,
            PurchaseStatus.MANUAL_REVIEW,
          ]),
        },
        relations: ['customer', 'paymentMethod', 'raffle'],
        order: { submittedAt: 'ASC' },
      });

      if (purchases.length === 0) {
        return;
      }

      const byPaymentMethod = new Map<string, any[][]>();

      for (const p of purchases) {
        const row: any[] = [
          new Date(p.submittedAt).toLocaleString('es-VE'),
          p.customer?.fullName ?? '-',
          p.customer?.nationalId ?? '-',
          p.customer?.email ?? '-',
          p.customer?.phone ?? '-',
          p.ticketQuantity,
          Number(p.totalAmount).toFixed(2),
          p.bankReference ?? '-',
          STATUS_LABELS[p.status] ?? p.status,
          p.paymentMethod?.accountHolderName ?? '-',
          p.raffle?.title ?? '-',
        ];
        const sheetName = toSheetName(p.paymentMethod?.name ?? 'Unknown');
        const rows = byPaymentMethod.get(sheetName) ?? [];
        rows.push(row);
        byPaymentMethod.set(sheetName, rows);
      }

      for (const [sheetName, rows] of byPaymentMethod) {
        await this.googleSheetsService.appendRows(
          spreadsheetId,
          sheetName,
          rows,
        );
      }

      const ids = purchases.map((p) => p.uid);
      await this.purchaseRepository.update(
        { uid: In(ids) },
        { exportedToSheets: true },
      );
      this.logger.log(`Exported ${purchases.length} purchases to Google Sheets`);
    } catch (err) {
      this.logger.error(
        'Failed to export purchases to Google Sheets',
        err instanceof Error ? err.stack : String(err),
      );
    } finally {
      this.isRunning = false;
    }
  }
}
