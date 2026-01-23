import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsUUID,
  IsOptional,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePaymentMethodDto {
  @ApiProperty({
    description: 'Nombre del método de pago',
    example: 'Transferencia Bancaria',
  })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiPropertyOptional({
    description: 'URL de la imagen del método de pago (se puede subir archivo o proporcionar URL)',
    example: 'https://example.com/payment-method.jpg',
  })
  @IsOptional()
  image_url?: string;

  @ApiProperty({
    description: 'Datos de configuración del método de pago (JSON)',
    example: { account_number: '1234567890', bank_name: 'Banco Ejemplo' },
  })
  @IsNotEmpty()
  payment_data: any;

  @ApiProperty({
    description: 'Monto mínimo de pago permitido',
    example: 10.0,
    type: Number,
    minimum: 0,
  })
  @IsNotEmpty()
  @Transform(({ value }) => parseFloat(String(value)))
  @IsNumber()
  minimum_payment_amount: number;

  @ApiProperty({
    description: 'UID de la divisa asociada',
    example: '123e4567-e89b-12d3-a456-426614174000',
    format: 'uuid',
  })
  @IsNotEmpty()
  @IsUUID()
  currency_id: string;
}
