import { IsOptional, IsString, IsNumber } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ExportPurchasesDto {
  @ApiPropertyOptional({
    description: 'Filtrar por UID de rifa',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsString()
  raffleId?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por símbolo de divisa',
    example: 'USD',
  })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por estado de compra',
    example: 'verified',
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por cédula del cliente',
    example: '1234567890',
  })
  @IsOptional()
  @IsString()
  nationalId?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por UID del método de pago',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsString()
  paymentMethodId?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por número de ticket',
    example: 12345,
    type: Number,
  })
  @IsOptional()
  @Transform(({ value }) => (value !== undefined ? Number(value) : undefined))
  @IsNumber()
  ticketNumber?: number;
}
