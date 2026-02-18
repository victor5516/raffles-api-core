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
// import { MailModule } from '../mail/mail.module';
// import { PurchasesMailListener } from './listeners/purchases-mail.listener';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Purchase,
      Ticket,
      Customer,
      Raffle,
      PaymentMethod,
      Currency,
    ]),
    // MailModule, // Deshabilitado: SES no funciona
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
  ], // PurchasesMailListener removido: SES no funciona
  exports: [PurchasesService, PurchasesExportService],
})
export class PurchasesModule {}
