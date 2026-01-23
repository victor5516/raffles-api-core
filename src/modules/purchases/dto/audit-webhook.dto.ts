import { ApiProperty } from '@nestjs/swagger';
import { IsNumberString, IsString, IsNotEmpty, IsEmail, IsOptional, IsUrl } from 'class-validator';

export class AuditWebhookDto {
  @ApiProperty({ description: 'UID de la rifa (ID del sistema externo)', example: '123e4567...' })
  @IsString()
  @IsNotEmpty()
  raffle_id: string;

  @ApiProperty({ description: 'Cantidad de tickets', example: '5', type: String })
  @IsNumberString() // Valida que el string sea un número ("5")
  @IsNotEmpty()
  ticket_quantity: string; // En DTOs de entrada, mejor string para evitar conflictos de parseo

  @ApiProperty({ description: 'Referencia bancaria', example: 'REF123456789' })
  @IsString()
  @IsNotEmpty()
  bank_reference: string;

  @ApiProperty({ description: 'Cédula', example: '1234567890' })
  @IsString()
  @IsNotEmpty()
  national_id: string;

  @ApiProperty({ description: 'Nombre completo', example: 'Juan Pérez' })
  @IsString()
  @IsNotEmpty()
  full_name: string;

  @ApiProperty({ description: 'Email', example: 'juan@example.com' })
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'Teléfono', example: '+584141234567' })
  @IsNotEmpty()
  @IsString()
  phone: string;

  @ApiProperty({ description: 'ID del método de pago (ID Externo)', example: '11' })
  @IsString()
  @IsNotEmpty()
  payment_method_id: string;

  @ApiProperty({ description: 'Nombre del método de pago (Respaldo)', example: 'Pago Móvil' })
  @IsString()
  @IsOptional() // Hazlo opcional por si acaso
  payment_method_name?: string;

  @ApiProperty({ description: 'URL de la imagen (si la tienen hosteada)', required: false })
  @IsString()
  @IsOptional()
  payment_screenshot?: string;

  @ApiProperty({ description: 'Monto total pagado', example: '50.00' })
  @IsNumberString()
  @IsNotEmpty()
  total_amount: string;

  @ApiProperty({ description: 'Símbolo moneda', example: 'USD' })
  @IsString()
  @IsNotEmpty()
  currency_symbol: string;

  @ApiProperty({ description: 'Fecha original de compra (ISO 8601)', example: '2025-12-31T10:00:00Z', required: false })
  @IsString()
  @IsOptional()
  created_at?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  ticket_numbers?: number[];
}