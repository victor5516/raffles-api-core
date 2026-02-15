import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import databaseConfig from '../src/config/database.config';
import { PaymentMethod } from '../src/modules/payments/entities/payment-method.entity';

dotenv.config();

const config = (databaseConfig as any)();

const dataSource = new DataSource({
  ...config,
});

async function backfillPaymentMethodSheetNames() {
  try {
    console.log('Connecting to database...');
    await dataSource.initialize();

    const paymentMethodRepo = dataSource.getRepository(PaymentMethod);
    const paymentMethods = await paymentMethodRepo.find();

    if (paymentMethods.length === 0) {
      console.log('No payment methods found. Nothing to update.');
      return;
    }

    let updated = 0;
    for (const paymentMethod of paymentMethods) {
      const currentSheetName = String(paymentMethod.sheetName ?? '').trim();
      if (currentSheetName) {
        continue;
      }

      paymentMethod.sheetName = paymentMethod.name;
      updated += 1;
    }

    if (updated === 0) {
      console.log('All payment methods already have sheet_name.');
      return;
    }

    await paymentMethodRepo.save(paymentMethods);
    console.log(`Backfill completed. Updated payment methods: ${updated}`);
  } catch (error) {
    console.error('Error backfilling payment method sheet_name:', error);
    process.exit(1);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

backfillPaymentMethodSheetNames();
