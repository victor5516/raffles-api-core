import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TicketsService } from './tickets.service';
import { TicketsController } from './tickets.controller';
import { Purchase } from '../purchases/entities/purchase.entity';
import { Raffle } from '../raffles/entities/raffle.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Purchase, Raffle])],
  controllers: [TicketsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
