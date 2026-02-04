import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import databaseConfig from '../src/config/database.config';
import { Purchase } from '../src/modules/purchases/entities/purchase.entity';
import { Raffle } from '../src/modules/raffles/entities/raffle.entity';
import { PaymentMethod } from '../src/modules/payments/entities/payment-method.entity';
import { calculatePromotionalTotal } from '../src/modules/raffles/utils/pricing.util';

dotenv.config();

// Reuse the same TypeORM config used by the Nest app (with synchronize on)
const config = (databaseConfig as any)();

const dataSource = new DataSource({
  ...config,
});

async function fixPurchaseTotals() {
  try {
    console.log('Connecting to database...');
    await dataSource.initialize();

    const purchaseRepo = dataSource.getRepository(Purchase);

    const BATCH_SIZE = 100;
    let processed = 0;
    let updated = 0;

    // Process in batches until there are no more purchases with total_amount NULL or 0
    while (true) {
      const batch = await purchaseRepo
        .createQueryBuilder('purchase')
        .leftJoinAndSelect('purchase.raffle', 'raffle')
        .leftJoinAndSelect('purchase.paymentMethod', 'paymentMethod')
        .leftJoinAndSelect('paymentMethod.currency', 'currency')
        .where('purchase."total_amount" IS NULL OR purchase."total_amount" = 0')
        .orderBy('purchase.submittedAt', 'ASC')
        .take(BATCH_SIZE)
        .getMany();

      if (batch.length === 0) {
        break;
      }

      for (const p of batch) {
        processed += 1;

        if (!p.raffle || !p.paymentMethod) {
          console.warn(
            `Skipping purchase ${p.uid} because raffle or paymentMethod relation is missing.`,
          );
          continue;
        }

        const raffle: Raffle = p.raffle as any;
        const paymentMethod: PaymentMethod = p.paymentMethod as any;

        const ticketPrice = Number(raffle.ticketPrice);
        const currencyValue = Number(paymentMethod.currency?.value ?? 1);

        if (!Number.isFinite(ticketPrice) || ticketPrice <= 0) {
          console.warn(
            `Skipping purchase ${p.uid}: invalid raffle.ticketPrice (${raffle.ticketPrice}).`,
          );
          continue;
        }

        if (!Number.isFinite(currencyValue) || currencyValue <= 0) {
          console.warn(
            `Skipping purchase ${p.uid}: invalid currency.value (${paymentMethod.currency?.value}).`,
          );
          continue;
        }

        const unitPriceInPaymentCurrency = ticketPrice * currencyValue;

        const calculatedTotal = calculatePromotionalTotal(
          unitPriceInPaymentCurrency,
          p.ticketQuantity,
          raffle.promotionStrategy ?? null,
          (raffle.promotionConfig as any) ?? null,
        );

        const totalAmountToPersist = Number(
          Number(calculatedTotal).toFixed(2),
        );

        if (!Number.isFinite(totalAmountToPersist) || totalAmountToPersist < 0) {
          console.warn(
            `Skipping purchase ${p.uid}: computed invalid totalAmount (${totalAmountToPersist}).`,
          );
          continue;
        }

        p.totalAmount = totalAmountToPersist;
        updated += 1;
      }

      if (batch.length > 0) {
        await purchaseRepo.save(batch);
        console.log(
          `Processed batch of ${batch.length} purchases. Total processed: ${processed}, updated: ${updated}`,
        );
      }
    }

    console.log(
      `Finished fixing purchase totals. Processed: ${processed}, updated: ${updated}`,
    );
  } catch (error) {
    console.error('Error fixing purchase totals:', error);
    process.exit(1);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

fixPurchaseTotals();

