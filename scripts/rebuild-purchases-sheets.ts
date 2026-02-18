import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PurchasesCron } from '../src/modules/purchases/purchases.cron';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const cron = app.get(PurchasesCron);
    const result = await cron.rebuildPurchasesSheets();
    // eslint-disable-next-line no-console
    console.log(
      `Rebuild completo de Google Sheets: ${result.purchases} compras, ${result.rows} filas, ${result.sheets} pestañas actualizadas.`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error al reconstruir Google Sheets de compras:', err);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

bootstrap();

