import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { Purchase, PromotionSnapshot } from '../src/modules/purchases/entities/purchase.entity';
import { Raffle } from '../src/modules/raffles/entities/raffle.entity';
import { PaymentMethod } from '../src/modules/payments/entities/payment-method.entity';
import { calculatePromotionalTotal } from '../src/modules/raffles/utils/pricing.util';

dotenv.config();

// DataSource created after dotenv.config() so DATABASE_URL is already loaded.
const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [path.join(__dirname, '/../src/**/*.entity{.ts,.js}')],
  synchronize: false,
  ssl: {
    rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true',
  },
});

const RAFFLE_ID = 'e518204e-56dc-44f8-b0b6-4b7b05b37c18';

/** Tolerancia para comparar totalAmount vs calculatedTotal (redondeos). */
const AMOUNT_TOLERANCE = 0.01;

// --dry-run → false by default: generates JSON preview without touching the DB.
// Pass --dry-run to execute and persist changes.
const dryRun = false;

interface MismatchInfo {
  totalAmountStored: number;
  calculatedTotal: number;
  diff: number;
}

interface PreviewEntry {
  purchaseUid: string;
  raffleId: string;
  ticketQuantity: number;
  totalAmount: number;
  calculatedTotal: number;
  totalMatches: boolean;
  mismatch?: MismatchInfo;
  proposedSnapshot: PromotionSnapshot;
}

async function main() {
  try {
    console.log('Connecting to database...');
    await dataSource.initialize();

    const purchaseRepo = dataSource.getRepository(Purchase);

    const purchases = await purchaseRepo
      .createQueryBuilder('purchase')
      .leftJoinAndSelect('purchase.raffle', 'raffle')
      .leftJoinAndSelect('purchase.paymentMethod', 'paymentMethod')
      .leftJoinAndSelect('paymentMethod.currency', 'currency')
      .where('purchase.promotion_snapshot IS NULL')
      .andWhere('purchase.raffle_id = :raffleId', { raffleId: RAFFLE_ID })
      .getMany();

    console.log(`Procesando ${purchases.length} compras sin snapshot...`);

    let skippedNoPromo = 0;
    let skippedNoDiscount = 0;
    let updated = 0;
    const preview: PreviewEntry[] = [];

    for (const purchase of purchases) {
      const raffle: Raffle = purchase.raffle;
      const pm: PaymentMethod = purchase.paymentMethod;

      if (!raffle || !raffle.promotionStrategy || !raffle.promotionConfig) {
        skippedNoPromo++;
        continue;
      }

      const unitPrice =
        Number(raffle.ticketPrice) * Number(pm?.currency?.value ?? 1);
      const calculatedTotal = calculatePromotionalTotal(
        unitPrice,
        purchase.ticketQuantity,
        raffle.promotionStrategy,
        raffle.promotionConfig,
      );
      const originalAmount = Number(
        (unitPrice * purchase.ticketQuantity).toFixed(2),
      );
      const discountAmount = Number(
        (originalAmount - calculatedTotal).toFixed(2),
      );

      if (discountAmount <= 0.01) {
        skippedNoDiscount++;
        continue;
      }

      const snapshot: PromotionSnapshot = {
        strategy: raffle.promotionStrategy,
        config: raffle.promotionConfig,
        originalAmount,
        discountAmount,
      };

      const totalAmountStored = Number(purchase.totalAmount);
      const totalMatches =
        Math.abs(totalAmountStored - calculatedTotal) <= AMOUNT_TOLERANCE;
      const mismatch: MismatchInfo | undefined = totalMatches
        ? undefined
        : {
            totalAmountStored,
            calculatedTotal,
            diff: Number((totalAmountStored - calculatedTotal).toFixed(2)),
          };

      if (dryRun) {
        preview.push({
          purchaseUid: purchase.uid,
          raffleId: purchase.raffleId,
          ticketQuantity: purchase.ticketQuantity,
          totalAmount: totalAmountStored,
          calculatedTotal,
          totalMatches,
          ...(mismatch && { mismatch }),
          proposedSnapshot: snapshot,
        });
      } else {
        if (!totalMatches) {
          console.warn(
            `[SKIP] purchase ${purchase.uid}: totalAmount=${totalAmountStored} != calculatedTotal=${calculatedTotal} (diff=${mismatch?.diff})`,
          );
          continue;
        }
        purchase.promotionSnapshot = snapshot;
        await purchaseRepo.save(purchase);
        updated++;
      }
    }

    if (dryRun) {
      const purchasesToUpdate = preview.filter((p) => p.totalMatches);
      const purchasesMismatch = preview.filter((p) => !p.totalMatches);
      const output = {
        generatedAt: new Date().toISOString(),
        raffleId: RAFFLE_ID,
        totalScanned: purchases.length,
        skippedNoPromo,
        skippedNoDiscount,
        toUpdate: purchasesToUpdate.length,
        mismatchCount: purchasesMismatch.length,
        purchasesToUpdate,
        purchasesMismatch,
      };
      const outPath = 'backfill-promotion-snapshots-preview.json';
      fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
      console.log(
        `Preview guardado en ${outPath}: ${purchasesToUpdate.length} a actualizar, ${purchasesMismatch.length} con monto inconsistente (no se backfillean).`,
      );
    } else {
      console.log(`Backfill completado: ${updated} compras actualizadas.`);
    }
  } catch (error) {
    console.error('Error en backfill:', error);
    process.exit(1);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

main();
