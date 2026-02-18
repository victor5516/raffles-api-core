import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsUUID,
  IsOptional,
  IsBoolean,
  Min,
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
    description:
      'Nombre de la hoja en Google Sheets (si no se envía, se usa el nombre original del método)',
    example: 'Transferencia Bancaria',
  })
  @IsOptional()
  @IsString()
  sheet_name?: string;

  @ApiPropertyOptional({
    description: 'Nombre del titular de la cuenta',
    example: 'Juan Perez',
  })
  @IsOptional()
  @IsString()
  accountHolderName?: string;

  @ApiPropertyOptional({
    description:
      'URL de la imagen del método de pago (se puede subir archivo o proporcionar URL)',
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

  @ApiPropertyOptional({
    description: 'Orden de visualización del método de pago',
    example: 1,
  })
  @IsOptional()
  @Transform(({ value }) =>
    value !== undefined ? parseInt(String(value), 10) : undefined,
  )
  @IsNumber()
  @Min(0)
  order?: number;

  @ApiProperty({
    description: 'UID de la divisa asociada',
    example: '123e4567-e89b-12d3-a456-426614174000',
    format: 'uuid',
  })
  @IsNotEmpty()
  @IsUUID()
  currency_id: string;

  @ApiPropertyOptional({
    description:
      'Si la verificación por IA está habilitada para este método de pago',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    return value === true || value === 'true';
  })
  @IsBoolean()
  ai_verification_enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Si el método de pago se muestra en el cliente',
    example: true,
  })
  @IsOptional()
  @Transform(({ obj }) => {
    const raw = obj.is_active;
    return raw === 'true' || raw === true;
  })
  @IsBoolean()
  is_active?: boolean;
}
