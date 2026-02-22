import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { BankStatementParserService } from './bank-statement-parser.service';
import { TicketAllocationService } from './ticket-allocation.service';
import { BankTransaction, ReconciliationResult } from '../dto/reconciliation.dto';
import {
  Purchase,
  PurchaseStatus,
  VerificationSource,
} from '../entities/purchase.entity';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly bankParser: BankStatementParserService,
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
    private readonly allocationService: TicketAllocationService,
  ) {}

  async reconcile(
    fileBuffer: Buffer,
    mimeType: string,
    paymentMethodId: string,
    raffleId: string,
  ): Promise<ReconciliationResult> {
    if (!paymentMethodId) {
      throw new BadRequestException('paymentMethodId es requerido');
    }
    if (!raffleId) {
      throw new BadRequestException('raffleId es requerido');
    }

    const bankTransactions =
      await this.bankParser.parseStatement(fileBuffer, mimeType);

    if (!bankTransactions.length) {
      throw new BadRequestException(
        'No se detectaron transacciones de crédito en el archivo provisto',
      );
    }

    const { minDate, maxDate } = this.getDateRange(bankTransactions);

    // Solo filtramos por rifa y método de pago; el match es por monto y referencia
    const dbPurchases = await this.entityManager.find(Purchase, {
      where: {
        raffleId,
        paymentMethodId,
      },
      order: {
        submittedAt: 'ASC',
      },
    });

    const {
      matched,
      unmatchedBank,
      unmatchedDb,
      totalBank,
      totalDb,
      purchasesToAutoVerify,
    } = this.matchTransactions(bankTransactions, dbPurchases);

    // Debug: cantidad de matches (independiente del estatus verified)
    this.logger.debug(
      `[Reconcile] Matches: ${matched.length} | Banco sin match: ${unmatchedBank.length} | DB sin match: ${unmatchedDb.length} | Total banco: ${totalBank} | Total DB: ${totalDb} | A auto-verificar: ${purchasesToAutoVerify.length}`,
    );

    // Auto-verificación de compras que hicieron match
    const now = new Date();
    const updatable = purchasesToAutoVerify.filter(
      (p) =>
        p.status === PurchaseStatus.PENDING ||
        p.status === PurchaseStatus.MANUAL_REVIEW
    );

    // Compras ya verified pero sin doble check: marcar auditReviewedAt
    const forAuditStamp = purchasesToAutoVerify.filter(
      (p) =>
        p.status === PurchaseStatus.VERIFIED && p.auditReviewedAt == null,
    );

    for (const purchase of updatable) {
      purchase.status = PurchaseStatus.VERIFIED;
      purchase.verificationSource = VerificationSource.BY_SYSTEM;
      purchase.verifiedAt = now;
    }

    for (const purchase of forAuditStamp) {
      purchase.auditReviewedAt = now;
      purchase.verificationSource = VerificationSource.BY_SYSTEM;
    }

    const toSave = [...updatable, ...forAuditStamp];
    if (toSave.length > 0) {
      await this.entityManager.transaction(async (txManager) => {
        // Assign ticket numbers for newly-verified RANDOM raffle purchases
        for (const purchase of updatable) {
          if (!purchase.ticketNumbers || purchase.ticketNumbers.length === 0) {
            await this.allocationService.assignRandomNumbers(
              txManager,
              purchase.raffleId,
              purchase,
            );
          }
        }
        await txManager.save(toSave);
      });
    }

    return {
      matched,
      unmatchedBank,
      unmatchedDb,
      metadata: {
        totalBank,
        totalDb,
        range: {
          start: minDate,
          end: maxDate,
        },
      },
    };
  }

  private getDateRange(transactions: BankTransaction[]): {
    minDate: Date;
    maxDate: Date;
  } {
    const dates: Date[] = [];

    for (const tx of transactions) {
      const d = new Date(tx.date);
      if (!Number.isNaN(d.getTime())) {
        dates.push(d);
      }
    }

    if (!dates.length) {
      const today = new Date();
      return { minDate: today, maxDate: today };
    }

    let minDate = dates[0];
    let maxDate = dates[0];

    for (const d of dates) {
      if (d < minDate) minDate = d;
      if (d > maxDate) maxDate = d;
    }

    return { minDate, maxDate };
  }

  private normalizeRef(value: string | null | undefined): string {
    if (!value) return '';
    const str = String(value);
    const normalized = str.normalize('NFKC');
    const upper = normalized.toUpperCase();
    const cleaned = upper.replace(/[^A-Z0-9]/g, '');
    return cleaned || '';
  }

  /**
   * Calcula la longitud del sufijo común entre dos referencias normalizadas.
   * Ejemplo: "005101282438" y "000084731282438" comparten el sufijo "1282438" (7 chars).
   */
  private commonSuffixLength(a: string, b: string): number {
    let i = a.length - 1;
    let j = b.length - 1;
    let count = 0;
    while (i >= 0 && j >= 0 && a[i] === b[j]) {
      count++;
      i--;
      j--;
    }
    return count;
  }

  /**
   * Dos referencias hacen match si comparten al menos MIN_SUFFIX_MATCH_LENGTH
   * caracteres finales consecutivos. Esto cubre los casos donde el banco emisor
   * y el banco receptor usan prefijos distintos pero el identificador de la
   * transacción coincide en el sufijo.
   * Ejemplo: ref DB="005101282438", ref banco="000084731282438" → sufijo común "1282438" (7) → match.
   */
  private readonly MIN_SUFFIX_MATCH_LENGTH = 7;

  private isReferenceMatch(
    normalizedRefA: string,
    normalizedRefB: string,
  ): boolean {
    if (!normalizedRefA || !normalizedRefB) return false;
    return this.commonSuffixLength(normalizedRefA, normalizedRefB) >= this.MIN_SUFFIX_MATCH_LENGTH;
  }

  /**
   * Extrae referencias de una compra siguiendo el orden de prioridad:
   * 1. ai_analysis_result->data->reference (referencia extraída por IA del OCR)
   * 2. payments[] array (cada pago tiene su referencia)
   * Retorna un array de { reference, amount } para poder hacer matching con cada pago individual
   */
  private extractPurchaseReferences(purchase: Purchase): Array<{
    reference: string;
    amount: number;
  }> {
    const refs: Array<{ reference: string; amount: number }> = [];

    // Prioridad 1: ai_analysis_result->data->reference
    if (
      purchase.aiAnalysisResult &&
      typeof purchase.aiAnalysisResult === 'object' &&
      purchase.aiAnalysisResult.data &&
      typeof purchase.aiAnalysisResult.data === 'object' &&
      purchase.aiAnalysisResult.data.reference
    ) {
      const aiRef = String(purchase.aiAnalysisResult.data.reference);
      const aiAmount =
        purchase.aiAnalysisResult.data.amount ??
        purchase.totalPaid ??
        purchase.totalAmount ??
        0;
      refs.push({
        reference: aiRef,
        amount: Number(aiAmount),
      });
      return refs; // Si tiene AI result, solo usamos ese
    }

    // Prioridad 2: payments[] array
    if (purchase.payments && Array.isArray(purchase.payments)) {
      for (const payment of purchase.payments) {
        if (payment.reference && payment.amount) {
          refs.push({
            reference: String(payment.reference),
            amount: Number(payment.amount),
          });
        }
      }
    }

    return refs;
  }

  private matchTransactions(
    bankTransactions: BankTransaction[],
    dbPurchases: Purchase[],
  ) {
    const matched: ReconciliationResult['matched'] = [];
    const matchedPurchaseIds = new Set<string>();

    const unmatchedBank: BankTransaction[] = [];
    const purchasesToAutoVerify: Purchase[] = [];

    let totalBank = 0;
    let totalDb = 0;

    for (const p of dbPurchases) {
      const amount = Number(p.totalPaid ?? p.totalAmount ?? 0);
      if (!Number.isNaN(amount)) {
        totalDb += amount;
      }
    }

    for (const tx of bankTransactions) {
      const bankAmount = Number(tx.amount);
      if (Number.isNaN(bankAmount)) {
        continue;
      }
      totalBank += bankAmount;

      const normBankRef = this.normalizeRef(tx.reference);
      if (!normBankRef) {
        unmatchedBank.push(tx);
        continue;
      }

      let found: Purchase | null = null;

      for (const purchase of dbPurchases) {
        if (matchedPurchaseIds.has(purchase.uid)) {
          continue;
        }

        // Extraer referencias siguiendo el orden de prioridad
        const purchaseRefs = this.extractPurchaseReferences(purchase);

        // Si no hay referencias, saltar esta compra
        if (purchaseRefs.length === 0) {
          continue;
        }

        // Buscar match en cada referencia extraída
        for (const { reference: purchaseRef, amount: purchaseAmount } of purchaseRefs) {
          const normPurchaseRef = this.normalizeRef(purchaseRef);
          if (!normPurchaseRef) continue;

          // Comparar montos (tolerancia 0.01)
          const amountDiff = Math.abs(bankAmount - purchaseAmount);
          const amountMatches = amountDiff <= 0.01;

          // Comparar referencias con matching parcial (mínimo 4 caracteres)
          const refMatches = this.isReferenceMatch(
            normBankRef,
            normPurchaseRef,
          );

          if (amountMatches && refMatches) {
            found = purchase;
            const signedDiff = Number(
              (bankAmount - purchaseAmount).toFixed(2),
            );
            matched.push({
              purchaseId: purchase.uid,
              bankRef: tx.reference,
              amount: bankAmount,
              diff: signedDiff,
            });
            purchasesToAutoVerify.push(purchase);
            matchedPurchaseIds.add(purchase.uid);
            break; // Salir del loop de referencias
          }
        }

        if (found) {
          break; // Salir del loop de compras
        }
      }

      if (!found) {
        unmatchedBank.push(tx);
      }
    }

    const unmatchedDb = dbPurchases.filter(
      (p) => !matchedPurchaseIds.has(p.uid),
    );

    return {
      matched,
      unmatchedBank,
      unmatchedDb,
      totalBank,
      totalDb,
      purchasesToAutoVerify,
    };
  }
}


