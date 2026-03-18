import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchasesService } from './purchases.service';
import { PurchasesExportService } from './services/purchases-export.service';
import { PurchaseVerificationService } from './services/purchase-verification.service';
import { PurchasesController } from './purchases.controller';
import { PurchasesCron } from './purchases.cron';
import { Purchase } from './entities/purchase.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Raffle } from '../raffles/entities/raffle.entity';
import { PaymentMethod } from '../payments/entities/payment-method.entity';
import { Currency } from '../currencies/entities/currency.entity';
import { GoogleSheetsService } from '../../common/services/google-sheets.service';
import { TicketAllocationService } from './services/ticket-allocation.service';
import { BankStatementParserService } from './services/bank-statement-parser.service';
import { ReconciliationService } from './services/reconciliation.service';
import { ReconciliationJobService } from './services/reconciliation-job.service';
import { ReconciliationJob } from './entities/reconciliation-job.entity';
import { ReconciliationJobListener } from './listeners/reconciliation-job.listener';
import { MailModule } from '../mail/mail.module';
import { CouponsModule } from '../coupons/coupons.module';
import { PurchasesMailListener } from './listeners/purchases-mail.listener';
import { PurchaseSentryInterceptor } from './interceptors/purchase-sentry.interceptor';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Purchase,
      Ticket,
      Customer,
      Raffle,
      PaymentMethod,
      Currency,
      ReconciliationJob,
    ]),
    MailModule,
    CouponsModule,
  ],
  controllers: [PurchasesController],
  providers: [
    PurchasesService,
    PurchasesExportService,
    PurchaseVerificationService,
    GoogleSheetsService,
    PurchasesCron,
    TicketAllocationService,
    BankStatementParserService,
    ReconciliationService,
    ReconciliationJobService,
    PurchasesMailListener,
    ReconciliationJobListener,
    PurchaseSentryInterceptor,
  ],
  exports: [PurchasesService, PurchasesExportService],
})
export class PurchasesModule {}
