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
    description: 'Ciudad del participante (opcional, puede ser null si solo se guarda state)',
    example: 'San Cristóbal',
    nullable: true,
  })
  city: string | null;

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
    description: 'Total de compras verificadas de la rifa',
    example: 1180,
  })
  totalPurchases: number;

  @ApiProperty({
    description:
      'Promedio de boletos por compra verificada. Null si no hay compras verificadas.',
    example: 4.22,
    nullable: true,
  })
  averageTicketsPerPurchase: number | null;

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
    description:
      'Cantidad de participantes únicos con compras verificadas en la rifa que no tienen ubicación (state) guardada',
    example: 54,
  })
  participantsWithoutLocation: number;

  @ApiProperty({
    description: 'Monto recogido usando totalPaid (compras verificadas)',
    example: 1250.75,
  })
  amountCollected: number;

  @ApiProperty({
    description:
      'Promedio de minutos entre ventas verificadas consecutivas. Null si hay menos de 2 ventas.',
    example: 10,
    nullable: true,
  })
  averageTimeBetweenSalesMinutes: number | null;

  @ApiProperty({
    description:
      'Total de compras de la rifa cuya verificación inicial fue por IA',
    example: 220,
  })
  aiApprovedTotal: number;

  @ApiProperty({
    description:
      'Compras aprobadas por IA que además tienen doble check humano (auditReviewedAt)',
    example: 180,
  })
  aiWithDoubleCheck: number;

  @ApiProperty({
    description:
      'Compras aprobadas por IA que actualmente están en estado rejected',
    example: 12,
  })
  aiApprovedThenRejected: number;

  @ApiProperty({
    description:
      'Compras aprobadas por IA con doble check humano, excluyendo las que están rejected',
    example: 168,
  })
  aiWithDoubleCheckEffective: number;

  @ApiProperty({
    description:
      'Compras evaluadas por IA que no fueron aprobadas automáticamente (manual_review, duplicated o rejected)',
    example: 42,
  })
  aiRejectedSales: number;
}
