import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { TicketsService } from './tickets.service';

@ApiTags('Tickets')
@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Get('search')
  @ApiOperation({ summary: 'Buscar tickets por cédula y rifa' })
  @ApiQuery({
    name: 'national_id',
    description: 'Cédula o identificación nacional del cliente',
    example: '1234567890',
    required: true,
  })
  @ApiQuery({
    name: 'raffle_uid',
    description: 'UID de la rifa',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Tickets encontrados',
  })
  @ApiResponse({ status: 400, description: 'Parámetros inválidos' })
  @ApiResponse({ status: 404, description: 'No se encontraron tickets' })
  search(
    @Query('national_id') nationalId: string,
    @Query('raffle_uid') raffleUid: string,
  ) {
    return this.ticketsService.search(nationalId, raffleUid);
  }
}
