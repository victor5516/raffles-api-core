import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  PaymentEntry,
  Purchase,
  PurchaseStatus,
} from './entities/purchase.entity';
import { PaymentMethod } from '../payments/entities/payment-method.entity';
import {
  GoogleSheetsService,
  SheetsPermissionError,
} from '../../common/services/google-sheets.service';
import { formatDateVenezuela } from '../../common/utils/date.util';

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

/** Resolve target sheet name using payment-level data first (multi-method purchases). */
function resolveSheetName(
  pay: PaymentEntry | undefined,
  purchase: Purchase,
  sheetNameByPaymentMethodId: Map<string, string>,
): string {
  const paymentMethodId = String(pay?.paymentMethodId ?? '').trim();
  const stableSheetName =
    paymentMethodId && sheetNameByPaymentMethodId.has(paymentMethodId)
      ? sheetNameByPaymentMethodId.get(paymentMethodId)
      : undefined;

  return toSheetName(
    stableSheetName ??
      pay?.paymentMethodName ??
      pay?.currency ??
      purchase.paymentMethod?.sheetName ??
      purchase.paymentMethod?.name ??
      'Unknown',
  );
}

@Injectable()
export class PurchasesCron {
  private readonly logger = new Logger(PurchasesCron.name);
  private isRunning = false;
  // Throttle between Sheets API calls in tight loops (ms). Can be tuned if needed.
  private readonly sheetsThrottleMs = Number(
    process.env.SHEETS_THROTTLE_MS ?? '200',
  );

  constructor(
    @InjectRepository(Purchase)
    private readonly purchaseRepository: Repository<Purchase>,
    @InjectRepository(PaymentMethod)
    private readonly paymentMethodRepository: Repository<PaymentMethod>,
    private readonly googleSheetsService: GoogleSheetsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async exportPurchasesToSheets(): Promise<void> {
    await this.runExport(false);
  }

  async rebuildPurchasesSheets(raffleId?: string): Promise<{
    purchases: number;
    rows: number;
    sheets: number;
  }> {
    return this.runExport(true, raffleId);
  }

  private async runExport(
    fullRebuild: boolean,
    raffleId?: string,
  ): Promise<{
    purchases: number;
    rows: number;
    sheets: number;
  }> {
    if (this.isRunning) {
      this.logger.warn('Export already in progress, skipping run');
      return { purchases: 0, rows: 0, sheets: 0 };
    }

    this.isRunning = true;
    // Cache of sheet names per spreadsheet shared across this export run
    const sheetNamesCache = new Map<string, string[]>();
    this.googleSheetsService.setSheetNamesCache(sheetNamesCache);
    try {
      const where: any = fullRebuild
        ? {}
        : {
            exportedToSheets: false,
          };

      if (raffleId) {
        where.raffle = { uid: raffleId };
      }

      const purchases = await this.purchaseRepository.find({
        where,
        relations: ['customer', 'paymentMethod', 'raffle'],
        order: { submittedAt: 'ASC' },
      });

      if (purchases.length === 0) {
        return { purchases: 0, rows: 0, sheets: 0 };
      }

      const missingSpreadsheet = purchases.filter(
        (p) =>
          !p.raffle ||
          !p.raffle.spreadsheetId ||
          String(p.raffle.spreadsheetId).trim().length === 0,
      );
      if (missingSpreadsheet.length > 0) {
        const ids = missingSpreadsheet.map((p) => p.uid).join(', ');
        throw new Error(
          `Some purchases belong to raffles without spreadsheetId configured: ${ids}`,
        );
      }

      const sheetNameByPaymentMethodId =
        await this.getSheetNameByPaymentMethodId(purchases);

      const purchasesBySpreadsheet = new Map<string, Purchase[]>();
      for (const p of purchases) {
        const raffleSpreadsheetId = String(p.raffle.spreadsheetId).trim();
        const current = purchasesBySpreadsheet.get(raffleSpreadsheetId) ?? [];
        current.push(p);
        purchasesBySpreadsheet.set(raffleSpreadsheetId, current);
      }

      const syncedPurchaseIds = new Set<string>();
      let syncedSheetsTotal = 0;
      let totalRows = 0;

      for (const [
        spreadsheetId,
        spreadsheetPurchases,
      ] of purchasesBySpreadsheet) {
        const byPaymentMethod = this.buildRowsByPaymentMethod(
          spreadsheetPurchases,
          sheetNameByPaymentMethodId,
        );

        if (!fullRebuild) {
          await this.clearStaleRowsAcrossCandidateSheets(
            spreadsheetId,
            spreadsheetPurchases,
            byPaymentMethod,
            sheetNameByPaymentMethodId,
          );
        }

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
            syncedSheetsTotal += 1;
            if (this.sheetsThrottleMs > 0) {
              await this.sleep(this.sheetsThrottleMs);
            }
          } catch (err) {
            if (err instanceof SheetsPermissionError) {
              this.logger.error(
                `Google Sheets permission error while syncing spreadsheet "${err.spreadsheetId}". ` +
                  'Verify that the spreadsheet is shared with the service account.',
              );
            } else {
              this.logger.error(
                `Failed syncing sheet "${sheetName}" in spreadsheet "${spreadsheetId}"`,
                err instanceof Error ? err.stack : String(err),
              );
            }
          }
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
        `${fullRebuild ? 'Rebuilt' : 'Exported'} ${ids.length} purchases (${totalRows} rows) across ${syncedSheetsTotal} sheets in ${purchasesBySpreadsheet.size} spreadsheet(s)`,
      );
      return {
        purchases: ids.length,
        rows: totalRows,
        sheets: syncedSheetsTotal,
      };
    } catch (err) {
      if (err instanceof SheetsPermissionError) {
        this.logger.error(
          `Failed to export purchases: Google Sheets permission error for spreadsheet "${err.spreadsheetId}". ` +
            'Ensure the spreadsheet is shared with the service account.',
        );
      } else {
        this.logger.error(
          'Failed to export purchases to Google Sheets',
          err instanceof Error ? err.stack : String(err),
        );
      }
      throw err;
    } finally {
      this.googleSheetsService.setSheetNamesCache(null);
      this.isRunning = false;
    }
  }

  private buildRowsByPaymentMethod(
    purchases: Purchase[],
    sheetNameByPaymentMethodId: Map<string, string>,
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
            const sheetName = resolveSheetName(
              pay,
              p,
              sheetNameByPaymentMethodId,
            );
            const rows = byPaymentMethod.get(sheetName) ?? [];
            rows.push({ uid: p.uid, values: [] });
            byPaymentMethod.set(sheetName, rows);
          }
        } else {
          const sheetName = toSheetName(
            p.paymentMethod?.sheetName ?? p.paymentMethod?.name ?? 'Unknown',
          );
          const rows = byPaymentMethod.get(sheetName) ?? [];
          rows.push({ uid: p.uid, values: [] });
          byPaymentMethod.set(sheetName, rows);
        }

        continue;
      }

      const date = formatDateVenezuela(p.submittedAt);
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
          const sheetName = resolveSheetName(
            pay,
            p,
            sheetNameByPaymentMethodId,
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
        const sheetName = toSheetName(
          p.paymentMethod?.sheetName ?? p.paymentMethod?.name ?? 'Unknown',
        );
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

  private async getSheetNameByPaymentMethodId(
    purchases: Purchase[],
  ): Promise<Map<string, string>> {
    const ids = new Set<string>();

    for (const p of purchases) {
      if (p.paymentMethodId) {
        ids.add(p.paymentMethodId);
      }
      const payments = p.payments ?? [];
      for (const pay of payments) {
        const paymentMethodId = String(pay.paymentMethodId ?? '').trim();
        if (paymentMethodId) {
          ids.add(paymentMethodId);
        }
      }
    }

    if (ids.size === 0) {
      return new Map<string, string>();
    }

    const paymentMethods = await this.paymentMethodRepository.find({
      where: { uid: In(Array.from(ids)) },
    });

    const map = new Map<string, string>();
    for (const method of paymentMethods) {
      map.set(method.uid, method.sheetName ?? method.name);
    }
    return map;
  }

  private async clearStaleRowsAcrossCandidateSheets(
    spreadsheetId: string,
    purchases: Purchase[],
    byPaymentMethod: Map<string, SheetSyncRow[]>,
    sheetNameByPaymentMethodId: Map<string, string>,
  ): Promise<void> {
    const existingSheetNames =
      await this.googleSheetsService.getSheetNames(spreadsheetId);
    if (existingSheetNames.length === 0) {
      return;
    }

    const candidateSheetNames =
      await this.buildIncrementalCleanupCandidateSheetNames(
        purchases,
        byPaymentMethod,
        sheetNameByPaymentMethodId,
      );
    const existingSet = new Set(existingSheetNames.map((name) => name.trim()));
    const targetSheetNames = Array.from(candidateSheetNames).filter((name) =>
      existingSet.has(name.trim()),
    );

    if (targetSheetNames.length === 0) {
      return;
    }

    const clearRows: SheetSyncRow[] = Array.from(
      new Set(purchases.map((p) => String(p.uid).trim()).filter(Boolean)),
    ).map((uid) => ({ uid, values: [] }));

    if (clearRows.length === 0) {
      return;
    }

    let clearedSheets = 0;
    for (const sheetName of targetSheetNames) {
      try {
        await this.googleSheetsService.syncRowsByUid(
          spreadsheetId,
          sheetName,
          clearRows,
          SHEET_HEADERS,
        );
        clearedSheets += 1;
        if (this.sheetsThrottleMs > 0) {
          await this.sleep(this.sheetsThrottleMs);
        }
      } catch (err) {
        this.logger.warn(
          `Failed clearing stale rows on sheet "${sheetName}"`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (clearedSheets > 0) {
      this.logger.log(
        `Cleared stale rows for ${clearRows.length} purchases across ${clearedSheets} sheets before sync`,
      );
    }
  }

  private async buildCleanupCandidateSheetNames(
    purchases: Purchase[],
    byPaymentMethod: Map<string, SheetSyncRow[]>,
    sheetNameByPaymentMethodId: Map<string, string>,
  ): Promise<Set<string>> {
    // Kept for potential future use (e.g. full rebuild cleanup). Currently not used.
    return this.buildIncrementalCleanupCandidateSheetNames(
      purchases,
      byPaymentMethod,
      sheetNameByPaymentMethodId,
    );
  }

  private async buildIncrementalCleanupCandidateSheetNames(
    purchases: Purchase[],
    byPaymentMethod: Map<string, SheetSyncRow[]>,
    sheetNameByPaymentMethodId: Map<string, string>,
  ): Promise<Set<string>> {
    const candidateSheetNames = new Set<string>();

    // Always include sheets that will be written in this run.
    for (const sheetName of byPaymentMethod.keys()) {
      candidateSheetNames.add(sheetName);
    }

    // Include sheet names directly derived from the purchases being processed.
    for (const p of purchases) {
      candidateSheetNames.add(
        toSheetName(
          p.paymentMethod?.sheetName ?? p.paymentMethod?.name ?? 'Unknown',
        ),
      );

      for (const pay of p.payments ?? []) {
        candidateSheetNames.add(
          resolveSheetName(pay, p, sheetNameByPaymentMethodId),
        );
        if (pay.paymentMethodName) {
          candidateSheetNames.add(toSheetName(pay.paymentMethodName));
        }
        if (pay.currency) {
          candidateSheetNames.add(toSheetName(pay.currency));
        }
      }
    }

    return candidateSheetNames;
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
