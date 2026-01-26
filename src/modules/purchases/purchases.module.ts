import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchasesService } from './purchases.service';
import { PurchasesController } from './purchases.controller';
import { Purchase } from './entities/purchase.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Raffle } from '../raffles/entities/raffle.entity';
import { PaymentMethod } from '../payments/entities/payment-method.entity';
import { Currency } from '../currencies/entities/currency.entity';
import { MailModule } from '../mail/mail.module';
import { PurchasesMailListener } from './listeners/purchases-mail.listener';

@Module({
  imports: [
    TypeOrmModule.forFeature([Purchase, Ticket, Customer, Raffle, PaymentMethod, Currency]),
    MailModule,
  ],
  controllers: [PurchasesController],
  providers: [PurchasesService, PurchasesMailListener],
  exports: [PurchasesService],
})
export class PurchasesModule {}
