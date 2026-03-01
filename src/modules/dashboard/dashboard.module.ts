import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { Purchase } from '../purchases/entities/purchase.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Raffle } from '../raffles/entities/raffle.entity';
import { Currency } from '../currencies/entities/currency.entity';
import { PaymentMethod } from '../payments/entities/payment-method.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Purchase,
      Customer,
      Raffle,
      Currency,
      PaymentMethod,
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
