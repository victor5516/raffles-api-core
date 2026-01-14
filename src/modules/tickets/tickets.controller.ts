import { Controller, Get, Query } from '@nestjs/common';
import { TicketsService } from './tickets.service';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Get('search')
  search(
    @Query('national_id') nationalId: string,
    @Query('raffle_uid') raffleUid: string,
  ) {
    return this.ticketsService.search(nationalId, raffleUid);
  }
}
