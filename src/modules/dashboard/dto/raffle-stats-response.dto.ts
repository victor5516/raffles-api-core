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
    description:
      'Ciudad del participante (opcional, puede ser null si solo se guarda state)',
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

export class RaffleAmountByCurrencyDto {
  @ApiProperty({
    description: 'UID de la divisa',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  currencyId: string;

  @ApiProperty({
    description: 'Nombre de la divisa',
    example: 'Dólar Estadounidense',
  })
  currencyName: string;

  @ApiProperty({
    description: 'Símbolo de la divisa',
    example: 'USD',
  })
  currencySymbol: string;

  @ApiProperty({
    description: 'Monto recogido en esta divisa (compras verificadas)',
    example: 1250.75,
  })
  amountCollected: number;

  @ApiProperty({
    description: 'Tasa de cambio (unidades de esta divisa por 1 USD)',
    example: 36.5,
  })
  exchangeRate: number;

  @ApiProperty({
    description: 'Monto recogido convertido a USD',
    example: 3480.82,
  })
  amountCollectedInUsd: number;
}

export class RaffleAmountByPaymentMethodDto {
  @ApiProperty({
    description: 'UID del método de pago',
    example: '0b402c17-b72c-4f73-b121-93c4df8a326f',
  })
  paymentMethodId: string;

  @ApiProperty({
    description: 'Nombre del método de pago',
    example: 'Pago Movil',
  })
  paymentMethodName: string;

  @ApiProperty({
    description: 'Símbolo de la divisa del método de pago',
    example: 'VES',
  })
  currencySymbol: string;

  @ApiProperty({
    description: 'Monto recogido con este método de pago (compras verificadas)',
    example: 127050,
  })
  amountCollected: number;

  @ApiProperty({
    description: 'Tasa de cambio (unidades de esta divisa por 1 USD)',
    example: 36.5,
  })
  exchangeRate: number;

  @ApiProperty({
    description: 'Monto recogido convertido a USD',
    example: 3480.82,
  })
  amountCollectedInUsd: number;

  @ApiProperty({
    description: 'Total de compras verificadas con este método de pago',
    example: 42,
  })
  totalPurchases: number;
}

export class RaffleTicketsSoldByDayDto {
  @ApiProperty({
    description: 'Fecha (YYYY-MM-DD)',
    example: '2026-02-12',
  })
  date: string;

  @ApiProperty({
    description: 'Cantidad de boletos vendidos en esa fecha',
    example: 184,
  })
  ticketsSold: number;
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
      'Monto total recogido convertido a dólares estadounidenses (USD), usando Currency.value como valor por dólar',
    example: 10.25,
  })
  amountCollectedInUsd: number;

  @ApiProperty({
    description:
      'Montos recogidos por cada divisa (compras verificadas). Se incluyen todas las divisas configuradas, aunque su monto sea 0.',
    type: () => [RaffleAmountByCurrencyDto],
  })
  amountCollectedByCurrency: RaffleAmountByCurrencyDto[];

  @ApiProperty({
    description:
      'Montos recogidos por cada método de pago (compras verificadas). Solo aparecen métodos con al menos una compra.',
    type: () => [RaffleAmountByPaymentMethodDto],
  })
  amountCollectedByPaymentMethod: RaffleAmountByPaymentMethodDto[];

  @ApiProperty({
    description:
      'Serie diaria de boletos vendidos (compras verificadas), útil para gráficas',
    type: () => [RaffleTicketsSoldByDayDto],
  })
  ticketsSoldByDay: RaffleTicketsSoldByDayDto[];

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
