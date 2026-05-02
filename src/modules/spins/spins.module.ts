import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customer } from '../customers/entities/customer.entity';
import { SpinPrizesAdminController } from './spin-prizes-admin.controller';
import { SpinsController } from './spins.controller';
import { SpinPrize } from './entities/spin-prize.entity';
import { SpinResult } from './entities/spin-result.entity';
import { SpinToken } from './entities/spin-token.entity';
import { SpinPrizesService } from './services/spin-prizes.service';
import { SpinsService } from './spins.service';

@Module({
  imports: [TypeOrmModule.forFeature([SpinPrize, SpinToken, SpinResult, Customer])],
  controllers: [SpinPrizesAdminController, SpinsController],
  providers: [SpinPrizesService, SpinsService],
  exports: [SpinsService],
})
export class SpinsModule {}
