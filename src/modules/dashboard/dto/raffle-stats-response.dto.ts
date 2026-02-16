import { ApiProperty } from '@nestjs/swagger';

export class RaffleSellDurationDto {
  @ApiProperty({
    description: 'Fecha de creación de la rifa (ISO string)',
    example: '2026-02-10T10:00:00.000Z',
  })
  raffleCreatedAt: string;

  @ApiProperty({
    description: 'Fecha/hora de la última venta verificada (ISO string)',
    example: '2026-02-12T18:30:00.000Z',
  })
  soldUntilAt: string;

  @ApiProperty({
    description: 'Duración de venta en horas',
    example: 56.5,
  })
  durationInHours: number;

  @ApiProperty({
    description: 'Duración de venta en días',
    example: 2.35,
  })
  durationInDays: number;
}

export class RaffleTopLocationDto {
  @ApiProperty({
    description: 'Estado del participante',
    example: 'Táchira',
  })
  state: string;

  @ApiProperty({
    description: 'Ciudad del participante',
    example: 'San Cristóbal',
  })
  city: string;

  @ApiProperty({
    description: 'Tickets vendidos en esta ubicación',
    example: 84,
  })
  ticketsSold: number;

  @ApiProperty({
    description: 'Cantidad de compras verificadas en esta ubicación',
    example: 21,
  })
  purchasesCount: number;

  @ApiProperty({
    description: 'Participantes únicos en esta ubicación',
    example: 17,
  })
  participantsCount: number;
}

export class RaffleStatsResponseDto {
  @ApiProperty({
    description: 'UID de la rifa',
  })
  raffleId: string;

  @ApiProperty({
    description: 'Título de la rifa',
  })
  raffleTitle: string;

  @ApiProperty({
    description: 'Cantidad de participantes únicos',
    example: 120,
  })
  participantsCount: number;

  @ApiProperty({
    description: 'Tickets vendidos',
    example: 480,
  })
  ticketsSold: number;

  @ApiProperty({
    description: 'Porcentaje de venta de tickets',
    example: 48,
  })
  salesPercentage: number;

  @ApiProperty({
    description:
      'Duración en vender desde creación de la rifa hasta la última venta verificada. Null si no hay ventas.',
    type: () => RaffleSellDurationDto,
    nullable: true,
  })
  sellDuration: RaffleSellDurationDto | null;

  @ApiProperty({
    description: 'Top 5 ubicaciones state/city con más tickets vendidos',
    type: () => [RaffleTopLocationDto],
  })
  topLocations: RaffleTopLocationDto[];

  @ApiProperty({
    description: 'Monto recogido usando totalPaid (compras verificadas)',
    example: 1250.75,
  })
  amountCollected: number;
}
