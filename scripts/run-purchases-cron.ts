import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PurchasesCron } from '../src/modules/purchases/purchases.cron';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const cron = app.get(PurchasesCron);
    // Ejecuta el export incremental normal (no full rebuild)
    await cron.exportPurchasesToSheets();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error running purchases cron manually:', err);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

bootstrap();

