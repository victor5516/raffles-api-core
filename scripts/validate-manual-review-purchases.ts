import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import databaseConfig from '../src/config/database.config';
import {
  Purchase,
  PurchaseStatus,
} from '../src/modules/purchases/entities/purchase.entity';

dotenv.config();

// Reuse the same TypeORM config used by the Nest app
const config = (databaseConfig as any)();

const dataSource = new DataSource({
  ...config,
});

interface ReceiptData {
  amount: number | null;
  currency: string | null;
  reference: string | null;
}

function normalizeReference(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const upper = String(raw).toUpperCase();
  const cleaned = upper.replace(/[^A-Z0-9]/g, '');
  return cleaned || null;
}

function validateReference(
  normalizedUserRef: string | null,
  normalizedAiRef: string | null,
): boolean {
  if (!normalizedUserRef || !normalizedAiRef) return false;

  // endsWith bidireccional
  const endsWithMatch =
    normalizedAiRef.endsWith(normalizedUserRef) ||
    normalizedUserRef.endsWith(normalizedAiRef);

  // contains bidireccional con mínimo 4 caracteres
  const containsMatch =
    normalizedAiRef.includes(normalizedUserRef) ||
    normalizedUserRef.includes(normalizedAiRef);

  const minLengthForContains = 4;
  const shorterRef =
    normalizedUserRef.length <= normalizedAiRef.length
      ? normalizedUserRef
      : normalizedAiRef;
  const longerRef =
    normalizedUserRef.length > normalizedAiRef.length
      ? normalizedUserRef
      : normalizedAiRef;

  return (
    endsWithMatch ||
    (containsMatch &&
      shorterRef.length >= minLengthForContains &&
      longerRef.includes(shorterRef))
  );
}

async function validateManualReviewPurchases() {
  try {
    console.log('Connecting to database...');
    await dataSource.initialize();

    const purchaseRepo = dataSource.getRepository(Purchase);

    // Buscar todas las compras con MANUAL_REVIEW que tengan aiAnalysisResult
    const manualReviewPurchases = await purchaseRepo
      .createQueryBuilder('purchase')
      .leftJoinAndSelect('purchase.paymentMethod', 'paymentMethod')
      .leftJoinAndSelect('paymentMethod.currency', 'currency')
      .where('purchase.status = :status', { status: PurchaseStatus.MANUAL_REVIEW })
      .andWhere('purchase.ai_analysis_result IS NOT NULL')
      .getMany();

    console.log(
      `Found ${manualReviewPurchases.length} purchases with status MANUAL_REVIEW and AI analysis data`,
    );

    if (manualReviewPurchases.length === 0) {
      console.log('No purchases to validate.');
      return;
    }

    const BATCH_SIZE = 100;
    let processed = 0;
    let verified = 0;
    let keptAsManualReview = 0;
    let markedAsDuplicated = 0;
    let skipped = 0;

    // Procesar en batches
    for (let i = 0; i < manualReviewPurchases.length; i += BATCH_SIZE) {
      const batch = manualReviewPurchases.slice(i, i + BATCH_SIZE);

      await dataSource.transaction(async (manager) => {
        for (const purchase of batch) {
          processed += 1;

          try {
            // A. Basic Integrity Check
            const aiData = purchase.aiAnalysisResult as ReceiptData;
            if (!aiData?.amount || !aiData?.currency || !aiData?.reference) {
              console.log(
                `Purchase ${purchase.uid}: Skipped - insufficient AI data (amount: ${aiData?.amount}, currency: ${aiData?.currency}, reference: ${aiData?.reference})`,
              );
              skipped += 1;
              continue;
            }

            // B. Duplicate Check (Fuzzy Reference Matching)
            const normalizedAiRef = normalizeReference(aiData.reference);
            if (!normalizedAiRef) {
              console.log(
                `Purchase ${purchase.uid}: Skipped - empty normalized AI reference`,
              );
              skipped += 1;
              continue;
            }

            const existingWithRef = await manager
              .getRepository(Purchase)
              .createQueryBuilder('p')
              .where('p.uid != :uid', { uid: purchase.uid })
              .andWhere(
                "REGEXP_REPLACE(UPPER(p.bank_reference), '[^A-Z0-9]', '', 'g') = :ref",
                { ref: normalizedAiRef },
              )
              .getOne();

            if (existingWithRef) {
              console.log(
                `Purchase ${purchase.uid}: Marked as DUPLICATED - found existing purchase with same reference (${existingWithRef.uid})`,
              );
              purchase.status = PurchaseStatus.DUPLICATED;
              await manager.save(Purchase, purchase);
              markedAsDuplicated += 1;
              continue;
            }

            // C. Amount Check (0.01 tolerance)
            const amountDiff = Math.abs(
              Number(purchase.totalAmount) - Number(aiData.amount),
            );
            const isAmountValid = amountDiff < 0.01;

            // D. Currency Check
            const expectedCurrency = purchase.paymentMethod?.currency;
            const isCurrencyValid =
              expectedCurrency?.symbol === aiData.currency;

            // E. Reference Check (Improved: endsWith OR contains)
            const normalizedUserRef = normalizeReference(purchase.bankReference);
            const isRefValid = validateReference(
              normalizedUserRef,
              normalizedAiRef,
            );

            // Log detallado de validación
            console.log(
              `Purchase ${purchase.uid}: ` +
                `Amount=${isAmountValid} (${purchase.totalAmount} vs ${aiData.amount}, diff=${amountDiff.toFixed(4)}), ` +
                `Currency=${isCurrencyValid} (${expectedCurrency?.symbol} vs ${aiData.currency}), ` +
                `Ref=${isRefValid} (User: "${purchase.bankReference}" -> "${normalizedUserRef}", AI: "${aiData.reference}" -> "${normalizedAiRef}")`,
            );

            // --- Decision Phase ---
            if (isAmountValid  && isRefValid) {
              purchase.status = PurchaseStatus.VERIFIED;
              purchase.verifiedAt = new Date();
              await manager.save(Purchase, purchase);
              verified += 1;
              console.log(
                `Purchase ${purchase.uid}: VERIFIED - All validations passed`,
              );
            } else {
              const reasons: string[] = [];
              if (!isAmountValid) {
                reasons.push(`Amount mismatch (diff: ${amountDiff.toFixed(4)})`);
              }
              if (!isCurrencyValid) {
                reasons.push(
                  `Currency mismatch (${expectedCurrency?.symbol} vs ${aiData.currency})`,
                );
              }
              if (!isRefValid) {
                reasons.push('Reference mismatch');
              }
              console.log(
                `Purchase ${purchase.uid}: Remains MANUAL_REVIEW - ${reasons.join(', ')}`,
              );
              keptAsManualReview += 1;
            }
          } catch (error) {
            console.error(
              `Error processing purchase ${purchase.uid}:`,
              error instanceof Error ? error.message : String(error),
            );
            skipped += 1;
          }
        }
      });

      console.log(
        `Processed batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(manualReviewPurchases.length / BATCH_SIZE)}. ` +
          `Total processed: ${processed}, verified: ${verified}, kept as MANUAL_REVIEW: ${keptAsManualReview}, duplicated: ${markedAsDuplicated}, skipped: ${skipped}`,
      );
    }

    console.log('\n=== Validation Summary ===');
    console.log(`Total purchases processed: ${processed}`);
    console.log(`Successfully verified: ${verified}`);
    console.log(`Remain in MANUAL_REVIEW: ${keptAsManualReview}`);
    console.log(`Marked as DUPLICATED: ${markedAsDuplicated}`);
    console.log(`Skipped (errors or missing data): ${skipped}`);
  } catch (error) {
    console.error('Error validating manual review purchases:', error);
    process.exit(1);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

validateManualReviewPurchases();
