import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RafflesService } from './raffles.service';
import { RafflesController } from './raffles.controller';
import { Raffle } from './entities/raffle.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { Purchase } from '../purchases/entities/purchase.entity';
import { CurrenciesModule } from '../currencies/currencies.module';

@Module({
  imports: [TypeOrmModule.forFeature([Raffle, Ticket, Purchase]), CurrenciesModule],
  controllers: [RafflesController],
  providers: [RafflesService],
  exports: [RafflesService],
})
export class RafflesModule {}
