import { ApiProperty } from '@nestjs/swagger';

export class RaffleOrdersSummaryCurrencyDto {
  @ApiProperty({ description: 'UID de la currency' })
  currencyUid: string;

  @ApiProperty({ description: 'Nombre de la currency' })
  name: string;

  @ApiProperty({ description: 'Símbolo de la currency', example: 'USD' })
  symbol: string;

  @ApiProperty({
    description:
      'Cantidad de órdenes en estados pending + manual_review para esta currency',
  })
  pendingAndManualCount: number;
}

export class RaffleOrdersSummaryTotalsDto {
  @ApiProperty({
    description: 'Cantidad total de órdenes de la rifa (todos los estados)',
  })
  allCount: number;

  @ApiProperty({
    description:
      'Cantidad total de órdenes en estados pending + manual_review de la rifa',
  })
  pendingAndManualCount: number;

  @ApiProperty({
    description: 'Cantidad total de órdenes rechazadas de la rifa',
  })
  rejectedCount: number;
}

export class RaffleOrdersSummaryResponseDto {
  @ApiProperty({ description: 'UID de la rifa' })
  raffleId: string;

  @ApiProperty({
    type: () => [RaffleOrdersSummaryCurrencyDto],
    description:
      'Listado de currencies con el conteo de órdenes pending + manual_review',
  })
  currencies: RaffleOrdersSummaryCurrencyDto[];

  @ApiProperty({
    type: () => RaffleOrdersSummaryTotalsDto,
    description: 'Totales globales de órdenes de la rifa',
  })
  totals: RaffleOrdersSummaryTotalsDto;
}

