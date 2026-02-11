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

const SHEET_HEADERS = [
  'Fecha',
  'Cliente',
  'Cédula',
  'Email',
  'Teléfono',
  'Tickets',
  'Monto',
  'Referencia',
  'Estado',
  'Vendedor',
  'Rifa',
  'UID',
];

interface SheetSyncRow {
  uid: string;
  values: any[];
}

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

  @Cron(CronExpression.EVERY_10_SECONDS)
  async exportPurchasesToSheets(): Promise<void> {
    await this.runExport(false);
  }

  async rebuildPurchasesSheets(): Promise<{
    purchases: number;
    rows: number;
    sheets: number;
  }> {
    return this.runExport(true);
  }

  private async runExport(fullRebuild: boolean): Promise<{
    purchases: number;
    rows: number;
    sheets: number;
  }> {
    if (this.isRunning) {
      this.logger.warn('Export already in progress, skipping run');
      return { purchases: 0, rows: 0, sheets: 0 };
    }

    const spreadsheetId = this.configService.get<string>('GOOGLE_SPREADSHEET_ID');
    if (!spreadsheetId) {
      this.logger.warn('GOOGLE_SPREADSHEET_ID not set, skipping export');
      return { purchases: 0, rows: 0, sheets: 0 };
    }

    this.isRunning = true;
    try {
      const purchases = await this.purchaseRepository.find({
        where: fullRebuild ? {} : { exportedToSheets: false },
        relations: ['customer', 'paymentMethod', 'raffle'],
        order: { submittedAt: 'ASC' },
      });

      if (purchases.length === 0) {
        return { purchases: 0, rows: 0, sheets: 0 };
      }

      const byPaymentMethod = this.buildRowsByPaymentMethod(purchases);
      const syncedPurchaseIds = new Set<string>();
      let syncedSheets = 0;
      let totalRows = 0;

      for (const [sheetName, rows] of byPaymentMethod) {
        try {
          if (fullRebuild) {
            await this.googleSheetsService.replaceSheetRows(
              spreadsheetId,
              sheetName,
              SHEET_HEADERS,
              rows.map((row) => row.values),
            );
          } else {
            await this.googleSheetsService.syncRowsByUid(
              spreadsheetId,
              sheetName,
              rows,
              SHEET_HEADERS,
            );
          }

          for (const row of rows) {
            syncedPurchaseIds.add(row.uid);
          }
          totalRows += rows.length;
          syncedSheets += 1;
        } catch (err) {
          this.logger.error(
            `Failed syncing sheet "${sheetName}"`,
            err instanceof Error ? err.stack : String(err),
          );
        }
      }

      const ids = Array.from(syncedPurchaseIds);
      if (ids.length > 0) {
        await this.purchaseRepository.update(
          { uid: In(ids) },
          { exportedToSheets: true },
        );
      }
      this.logger.log(
        `${fullRebuild ? 'Rebuilt' : 'Exported'} ${ids.length} purchases (${totalRows} rows) across ${syncedSheets} sheets`,
      );
      return { purchases: ids.length, rows: totalRows, sheets: syncedSheets };
    } catch (err) {
      this.logger.error(
        'Failed to export purchases to Google Sheets',
        err instanceof Error ? err.stack : String(err),
      );
      return { purchases: 0, rows: 0, sheets: 0 };
    } finally {
      this.isRunning = false;
    }
  }

  private buildRowsByPaymentMethod(
    purchases: Purchase[],
  ): Map<string, SheetSyncRow[]> {
    const byPaymentMethod = new Map<string, SheetSyncRow[]>();

    for (const p of purchases) {
      const payments = p.payments ?? [];

      // Si la compra está REJECTED o DUPLICATED, limpiamos cualquier fila existente
      // en el Sheet para ese UID enviando una fila \"vacía\" (values = []).
      if (
        p.status === PurchaseStatus.REJECTED ||
        p.status === PurchaseStatus.DUPLICATED
      ) {
        if (payments.length > 0) {
          for (const pay of payments) {
            const sheetName = toSheetName(
              pay.paymentMethodName ?? p.paymentMethod?.name ?? 'Unknown',
            );
            const rows = byPaymentMethod.get(sheetName) ?? [];
            rows.push({ uid: p.uid, values: [] });
            byPaymentMethod.set(sheetName, rows);
          }
        } else {
          const sheetName = toSheetName(p.paymentMethod?.name ?? 'Unknown');
          const rows = byPaymentMethod.get(sheetName) ?? [];
          rows.push({ uid: p.uid, values: [] });
          byPaymentMethod.set(sheetName, rows);
        }

        continue;
      }

      const date = new Date(p.submittedAt).toLocaleString('es-VE');
      const customerName = p.customer?.fullName ?? '-';
      const nationalId = p.customer?.nationalId ?? '-';
      const email = p.customer?.email ?? '-';
      const phone = p.customer?.phone ?? '-';
      const statusLabel = STATUS_LABELS[p.status] ?? p.status;
      const raffleName = p.raffle?.title ?? '-';
      const fallbackSeller = p.paymentMethod?.accountHolderName ?? '-';

      if (payments.length > 0) {
        // 1 fila por cada pago (abono). Tickets solo en la primera fila.
        for (let i = 0; i < payments.length; i++) {
          const pay = payments[i];
          const sheetName = toSheetName(
            pay.paymentMethodName ?? p.paymentMethod?.name ?? 'Unknown',
          );
          const values: any[] = [
            date,
            customerName,
            nationalId,
            email,
            phone,
            i === 0 ? p.ticketQuantity : 0,
            Number(pay.amount).toFixed(2).replace('.', ','),
            pay.reference || '-',
            statusLabel,
            fallbackSeller,
            raffleName,
            p.uid,
          ];
          const rows = byPaymentMethod.get(sheetName) ?? [];
          rows.push({ uid: p.uid, values });
          byPaymentMethod.set(sheetName, rows);
        }
      } else {
        // Legacy: compra sin payments[], 1 fila como antes
        const sheetName = toSheetName(p.paymentMethod?.name ?? 'Unknown');
        const values: any[] = [
          date,
          customerName,
          nationalId,
          email,
          phone,
          p.ticketQuantity,
          Number(p.totalAmount).toFixed(2).replace('.', ','),
          p.bankReference ?? '-',
          statusLabel,
          fallbackSeller,
          raffleName,
          p.uid,
        ];
        const rows = byPaymentMethod.get(sheetName) ?? [];
        rows.push({ uid: p.uid, values });
        byPaymentMethod.set(sheetName, rows);
      }
    }

    return byPaymentMethod;
  }
}
