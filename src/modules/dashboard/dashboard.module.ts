import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { Purchase } from '../purchases/entities/purchase.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Raffle } from '../raffles/entities/raffle.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Purchase, Customer, Raffle])],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}

