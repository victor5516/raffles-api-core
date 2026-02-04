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

function normalizeReference(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const upper = String(raw).toUpperCase();
  const cleaned = upper.replace(/[^A-Z0-9]/g, '');
  return cleaned || null;
}

async function reviewDuplicatedPurchases() {
  try {
    console.log('Connecting to database...');
    await dataSource.initialize();

    const purchaseRepo = dataSource.getRepository(Purchase);

    const duplicatedPurchases = await purchaseRepo.find({
      where: { status: PurchaseStatus.DUPLICATED },
    });

    console.log(
      `Found ${duplicatedPurchases.length} purchases with status DUPLICATED`,
    );

    let keptAsDuplicated = 0;
    let movedToManualReview = 0;

    for (const p of duplicatedPurchases) {
      const normalizedRef = normalizeReference(p.bankReference);

      if (!normalizedRef) {
        console.log(
          `Purchase ${p.uid} has no usable reference, moving to MANUAL_REVIEW`,
        );
        p.status = PurchaseStatus.MANUAL_REVIEW;
        await purchaseRepo.save(p);
        movedToManualReview += 1;
        continue;
      }

      const candidates = await purchaseRepo
        .createQueryBuilder('purchase')
        .where('purchase.uid != :uid', { uid: p.uid })
        .andWhere(
          "REGEXP_REPLACE(UPPER(purchase.bank_reference), '[^A-Z0-9]', '', 'g') = :normalizedRef",
          { normalizedRef },
        )
        .getMany();

      const hasRealDuplicate = candidates.some((other) => {
        const amountDiff = Math.abs(
          Number(other.totalAmount ?? 0) - Number(p.totalAmount ?? 0),
        );
        return amountDiff < 0.01;
      });

      if (hasRealDuplicate) {
        keptAsDuplicated += 1;
        console.log(
          `Purchase ${p.uid} remains DUPLICATED (found at least one real duplicate).`,
        );
      } else {
        p.status = PurchaseStatus.MANUAL_REVIEW;
        await purchaseRepo.save(p);
        movedToManualReview += 1;
        console.log(
          `Purchase ${p.uid} moved to MANUAL_REVIEW (no real duplicate found).`,
        );
      }
    }

    console.log(
      `Review completed. Kept as DUPLICATED: ${keptAsDuplicated}, moved to MANUAL_REVIEW: ${movedToManualReview}`,
    );
  } catch (error) {
    console.error('Error reviewing duplicated purchases:', error);
    process.exit(1);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

reviewDuplicatedPurchases();

