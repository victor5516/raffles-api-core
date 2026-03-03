import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { BankStatementParserService } from './bank-statement-parser.service';
import { TicketAllocationService } from './ticket-allocation.service';
import {
  BankTransaction,
  ReconciliationResult,
} from '../dto/reconciliation.dto';
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

    const bankTransactions = await this.bankParser.parseStatement(
      fileBuffer,
      mimeType,
    );

    if (!bankTransactions.length) {
      throw new BadRequestException(
        'No se detectaron transacciones de crédito en el archivo provisto',
      );
    }

    const { minDate, maxDate } = this.getDateRange(bankTransactions);

    // Solo filtramos por rifa y método de pago; el match es por monto y referencia
    // Cargamos también el cliente para poder incluir snapshots en los resultados.
    const dbPurchases = await this.entityManager.find(Purchase, {
      where: {
        raffleId,
        paymentMethodId,
      },
      relations: ['customer'],
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
      `[Reconcile] Matches: ${matched.length} | Banco sin match: ${unmatchedBank.length} | DB sin match: ${unmatchedDb.length} | Total banco: ${totalBank} | Total DB: ${totalDb} | A auto-verificar: ${purchasesToAutoVerify.length}
       | Canitdad Bancaria: ${bankTransactions.length} `,
    );

    // Auto-verificación de compras que hicieron match
    const now = new Date();
    const updatable = purchasesToAutoVerify.filter(
      (p) =>
        p.status === PurchaseStatus.PENDING ||
        p.status === PurchaseStatus.MANUAL_REVIEW,
    );

    // Compras ya verified pero sin doble check: marcar auditReviewedAt
    const forAuditStamp = purchasesToAutoVerify.filter(
      (p) => p.status === PurchaseStatus.VERIFIED && p.auditReviewedAt == null,
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
  private readonly AMOUNT_TOLERANCE = 1.0;
  private readonly MIN_SUFFIX_MATCH_LENGTH = 7;

  private isReferenceMatch(
    normalizedRefA: string,
    normalizedRefB: string,
  ): boolean {
    if (!normalizedRefA || !normalizedRefB) return false;
    return (
      this.commonSuffixLength(normalizedRefA, normalizedRefB) >=
      this.MIN_SUFFIX_MATCH_LENGTH
    );
  }

  private extractPurchaseReferences(purchase: Purchase): Array<{
    reference: string;
    amount: number;
  }> {
    const refs: Array<{ reference: string; amount: number }> = [];
    const seen = new Set<string>();
    const defaultAmount = Number(
      purchase.totalPaid ?? purchase.totalAmount ?? 0,
    );

    const tryAdd = (ref: string | null | undefined, amount: number) => {
      if (!ref) return;
      const norm = this.normalizeRef(ref);
      if (!norm || seen.has(norm)) return;
      seen.add(norm);
      refs.push({ reference: String(ref), amount });
    };

    // Candidato 1: ai_analysis_result->data->reference
    const aiResult = purchase.aiAnalysisResult as
      | { data?: { reference?: string; amount?: number } }
      | null
      | undefined;
    if (aiResult?.data?.reference) {
      const aiAmount = Number(
        aiResult.data.amount ?? purchase.totalPaid ?? purchase.totalAmount ?? 0,
      );
      tryAdd(String(aiResult.data.reference), aiAmount);
    }

    // Candidato 2: payments[]
    if (Array.isArray(purchase.payments)) {
      for (const payment of purchase.payments) {
        if (payment.reference) {
          tryAdd(
            String(payment.reference),
            Number(payment.amount ?? defaultAmount),
          );
        }
      }
    }

    // Candidato 3: bankReference (campo legacy)
    if (purchase.bankReference) {
      tryAdd(String(purchase.bankReference), defaultAmount);
    }

    return refs;
  }

  private extractRefFromDescription(description: string): string {
    if (!description) return '';
    const matches = description.match(/\d{7,}/g);
    if (!matches || matches.length === 0) return '';
    return matches.reduce(
      (longest, current) =>
        current.length > longest.length ? current : longest,
      '',
    );
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

      const bankRefRaw =
        tx.reference || this.extractRefFromDescription(tx.description);
      const normBankRef = this.normalizeRef(bankRefRaw);
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
        for (const {
          reference: purchaseRef,
          amount: purchaseAmount,
        } of purchaseRefs) {
          const normPurchaseRef = this.normalizeRef(purchaseRef);
          if (!normPurchaseRef) continue;

          // Comparar montos (tolerancia 0.01)
          const amountDiff = Math.abs(bankAmount - purchaseAmount);
          const amountMatches = amountDiff <= this.AMOUNT_TOLERANCE;

          // Comparar referencias por sufijo (mínimo MIN_SUFFIX_MATCH_LENGTH = 7 caracteres)
          const refMatches = this.isReferenceMatch(
            normBankRef,
            normPurchaseRef,
          );

          if (amountMatches && refMatches) {
            found = purchase;
            const signedDiff = Number((bankAmount - purchaseAmount).toFixed(2));
            matched.push({
              purchaseId: purchase.uid,
              bankRef: bankRefRaw,
              amount: bankAmount,
              diff: signedDiff,
              purchaseSnapshot: {
                uid: purchase.uid,
                customerName: purchase.customer?.fullName ?? '',
                totalAmount: Number(
                  purchase.totalPaid ?? purchase.totalAmount ?? 0,
                ),
                status: purchase.status,
              },
              bankTransaction: tx,
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
