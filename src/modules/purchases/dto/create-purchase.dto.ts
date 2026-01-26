import {
  IsNotEmpty,
  IsString,
  IsNumber,
  Min,
  IsEmail,
  IsOptional,
  IsArray,
  ArrayMinSize,
  IsInt,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiProperty({
    description: 'Referencia bancaria del pago',
    example: 'REF123456789',
  })
  @IsNotEmpty()
  @IsString()
  bank_reference: string;

  @ApiProperty({
    description: 'Datos del cliente (JSON string en multipart form)',
    type: CustomerDto,
  })
  // customer is received as JSON string in multipart form
  @IsNotEmpty()
  customer: CustomerDto;

  @ApiPropertyOptional({
    description: 'URL de la captura de pantalla del pago (se puede subir archivo o proporcionar URL)',
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
    description: 'Números de tickets específicos a comprar (requerido para rifas de tipo SPECIFIC)',
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
  @ArrayMinSize(1, { message: 'ticket_numbers must contain at least one number' })
  @IsInt({ each: true })
  @Min(0, { each: true })
  ticket_numbers?: number[];

}
