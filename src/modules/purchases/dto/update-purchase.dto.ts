import {
  IsOptional,
  IsString,
  IsEnum,
  IsNumber,
  IsArray,
  IsInt,
  IsBoolean,
  IsObject,
  Min,
  ValidateNested,
  IsUUID,
  Allow,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PurchaseStatus } from '../entities/purchase.entity';
import { CustomerDto } from './create-purchase.dto';

export class UpdatePaymentEntryDto {
  @IsNumber()
  @Min(0)
  amount: number;

  @IsString()
  reference: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  evidenceUrl?: string;

  @IsOptional()
  @IsBoolean()
  verified?: boolean;

  @IsOptional()
  @Allow()
  aiResult?: any;

  @IsOptional()
  @IsString()
  reviewedBy?: string;

  @IsOptional()
  @IsString()
  paymentMethodId?: string;

  @IsOptional()
  @IsString()
  paymentMethodName?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return value;
      }
    }
    return value;
  })
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdatePurchaseDto {
  @ApiPropertyOptional({
    description: 'Notas de la compra',
    example: 'Cliente contactado, pago verificado manualmente',
  })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    description: 'UID de la rifa',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsString()
  @IsUUID()
  raffleId?: string;

  @ApiPropertyOptional({
    description: 'UID del método de pago',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsString()
  @IsUUID()
  paymentMethodId?: string;

  @ApiPropertyOptional({
    description: 'UID del cliente (alternativa a enviar objeto customer)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsString()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    description:
      'Datos del cliente para actualizar o crear inline (prioridad sobre customerId)',
    type: CustomerDto,
  })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as CustomerDto;
      } catch {
        return value;
      }
    }
    return value;
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerDto)
  customer?: CustomerDto;

  @ApiPropertyOptional({
    description: 'Cantidad de tickets',
    example: 5,
    type: Number,
    minimum: 1,
  })
  @IsOptional()
  @Transform(({ value }) =>
    value !== undefined && value !== ''
      ? parseInt(String(value), 10)
      : undefined,
  )
  @IsInt()
  @Min(1)
  ticket_quantity?: number;

  @ApiPropertyOptional({
    description: 'Referencia bancaria del pago',
    example: 'REF123456789',
  })
  @IsOptional()
  @IsString()
  bank_reference?: string;

  @ApiPropertyOptional({
    description: 'Estado de la compra',
    enum: PurchaseStatus,
    example: PurchaseStatus.VERIFIED,
  })
  @IsOptional()
  @IsEnum(PurchaseStatus)
  status?: PurchaseStatus;

  @ApiPropertyOptional({
    description: 'Monto total del pago',
    example: 50.0,
    type: Number,
    minimum: 0,
  })
  @IsOptional()
  @Transform(({ value }) =>
    value !== undefined && value !== '' ? parseFloat(String(value)) : undefined,
  )
  @IsNumber()
  @Min(0)
  totalAmount?: number;

  @ApiPropertyOptional({
    description:
      'URL o key del comprobante de pago (alternativa a subir archivo)',
    example: 'https://example.com/screenshot.jpg',
  })
  @IsOptional()
  @IsString()
  payment_screenshot_url?: string;

  @ApiPropertyOptional({
    description:
      'Números de tickets asignados (reemplaza la lista actual; se valida rango y disponibilidad)',
    example: [1, 5, 10, 15, 20],
    type: [Number],
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  })
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  ticket_numbers?: number[];

  @ApiPropertyOptional({
    description: 'Array de pagos (abonos) para reemplazar los existentes',
    type: [UpdatePaymentEntryDto],
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdatePaymentEntryDto)
  payments?: UpdatePaymentEntryDto[];
}
