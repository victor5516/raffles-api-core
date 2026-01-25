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

  @ApiPropertyOptional({
    description: 'Filtrar por nombre del participante',
    example: 'Juan Pérez',
  })
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por email del participante',
    example: 'juan.perez@example.com',
  })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por teléfono del participante',
    example: '+1234567890',
  })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por fecha desde (formato ISO date)',
    example: '2024-01-01',
  })
  @IsOptional()
  @IsString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por fecha hasta (formato ISO date)',
    example: '2024-12-31',
  })
  @IsOptional()
  @IsString()
  dateTo?: string;
}
