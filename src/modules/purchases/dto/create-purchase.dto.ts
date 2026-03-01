import {
  IsNotEmpty,
  IsString,
  IsNumber,
  Min,
  IsEmail,
  IsOptional,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsInt,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CustomerLocationDto } from '../../customers/dto/customer-location.dto';

export class PaymentItemDto {
  @ApiProperty({
    description: 'Monto de este pago (abono)',
    example: 25.0,
    type: Number,
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({
    description: 'Referencia bancaria de este pago',
    example: 'REF123456789',
  })
  @IsString()
  @IsNotEmpty()
  reference: string;

  @ApiPropertyOptional({
    description: 'Símbolo de la moneda del pago',
    example: 'USD',
  })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({
    description: 'URL del comprobante de pago',
    example: 'https://example.com/screenshot.jpg',
  })
  @IsOptional()
  @IsString()
  evidenceUrl?: string;

  @ApiPropertyOptional({
    description:
      'UID del método de pago para este abono (si difiere del principal)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsString()
  paymentMethodId?: string;

  @ApiPropertyOptional({
    description: 'Nombre del método de pago para este abono',
    example: 'Zelle',
  })
  @IsOptional()
  @IsString()
  paymentMethodName?: string;
}

export class CustomerDto {
  @ApiProperty({
    description: 'Cédula o identificación nacional del cliente',
    example: '1234567890',
  })
  @IsNotEmpty()
  @IsString()
  national_id: string;

  @ApiProperty({
    description: 'Nombre completo del cliente',
    example: 'Juan Pérez',
  })
  @IsNotEmpty()
  @IsString()
  full_name: string;

  @ApiProperty({
    description: 'Email del cliente',
    example: 'juan.perez@example.com',
  })
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @ApiPropertyOptional({
    description: 'Teléfono del cliente',
    example: '+1234567890',
  })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({
    description: 'Ubicación del cliente (estado, etc.)',
    type: CustomerLocationDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerLocationDto)
  location?: CustomerLocationDto;
}

export class CreatePurchaseDto {
  @ApiProperty({
    description: 'UID de la rifa',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsNotEmpty()
  @IsString() // ID
  raffleId: string;

  @ApiProperty({
    description: 'UID del método de pago',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsNotEmpty()
  @IsString() // ID
  paymentMethodId: string;

  @ApiProperty({
    description: 'Cantidad de tickets a comprar',
    example: 5,
    type: Number,
    minimum: 1,
  })
  @IsNotEmpty()
  @Transform(({ value }) => parseInt(String(value)))
  @IsNumber()
  @Min(1)
  ticket_quantity: number;

  @ApiPropertyOptional({
    description:
      'Referencia bancaria del pago (requerido si no se envía payments[])',
    example: 'REF123456789',
  })
  @IsOptional()
  @IsString()
  bank_reference?: string;

  @ApiProperty({
    description: 'Datos del cliente (JSON string en multipart form)',
    type: CustomerDto,
  })
  // customer is received as JSON string in multipart form
  @IsNotEmpty()
  customer: CustomerDto;

  @ApiPropertyOptional({
    description:
      'URL de la captura de pantalla del pago (se puede subir archivo o proporcionar URL)',
    example: 'https://example.com/screenshot.jpg',
  })
  // payment_screenshot_url handled by interceptor
  payment_screenshot_url?: string;

  @ApiProperty({
    description: 'Monto total del pago',
    example: 50.0,
    type: Number,
    minimum: 0,
  })
  @IsNotEmpty()
  @Transform(({ value }) => parseFloat(String(value)))
  @IsNumber()
  @Min(0)
  totalAmount: number;

  @ApiPropertyOptional({
    description:
      'Números de tickets específicos a comprar (requerido para rifas de tipo SPECIFIC)',
    example: [1, 5, 10, 15, 20],
    type: [Number],
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    // In multipart/form-data, arrays may arrive as JSON strings
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
  @ArrayMinSize(1, {
    message: 'ticket_numbers must contain at least one number',
  })
  @IsInt({ each: true })
  @Min(0, { each: true })
  ticket_numbers?: number[];

  @ApiPropertyOptional({
    description:
      'Array de pagos (abonos). Si se proporciona, se usa en lugar de bank_reference/payment_screenshot_url.',
    type: [PaymentItemDto],
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
  @Type(() => PaymentItemDto)
  payments?: PaymentItemDto[];

  @ApiPropertyOptional({
    description: 'Códigos de cupones a canjear. Cada cupón cubre 1 ticket.',
    example: ['A3K9BZ', 'X7T2QR'],
    type: [String],
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
  @IsString({ each: true })
  @ArrayMaxSize(100)
  couponCodes?: string[];
}
