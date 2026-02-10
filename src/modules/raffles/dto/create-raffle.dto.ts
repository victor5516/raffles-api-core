import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsEnum,
  Min,
  IsObject,
  IsBoolean,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RaffleStatus, RaffleSelectionType } from '../entities/raffle.entity';
import { PromotionStrategy } from '../utils/pricing.util';

export class CreateRaffleDto {
  @ApiProperty({
    description: 'Título de la rifa',
    example: 'Rifa de Navidad 2024',
  })
  @IsNotEmpty()
  @IsString()
  title: string;

  @ApiPropertyOptional({
    description: 'Descripción de la rifa',
    example: 'Rifa especial para celebrar la navidad',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Longitud de dígitos para los números de ticket',
    example: 6,
    type: Number,
  })
  @IsOptional()
  @Transform(({ value }) => parseInt(String(value)))
  @IsNumber()
  digits_length: number;

  @ApiPropertyOptional({
    description: 'Cantidad mínima de tickets por compra',
    example: 1,
    type: Number,
  })
  @IsOptional()
  @Transform(({ value }) => parseInt(String(value)))
  @IsNumber()
  min_tickets_per_purchase: number;

  @ApiProperty({
    description: 'Precio de cada ticket',
    example: 10.5,
    type: Number,
    minimum: 0,
  })
  @IsNotEmpty()
  @Transform(({ value }) => parseFloat(String(value)))
  @IsNumber()
  @Min(0)
  ticket_price: number;

  @ApiProperty({
    description: 'Número total de tickets disponibles',
    example: 1000,
    type: Number,
    minimum: 1,
  })
  @IsNotEmpty()
  @Transform(({ value }) => parseInt(String(value)))
  @IsNumber()
  @Min(1)
  total_tickets: number;

  @ApiProperty({
    description: 'Fecha límite de la rifa (ISO 8601)',
    example: '2024-12-31T23:59:59.000Z',
  })
  @IsNotEmpty()
  @IsDateString()
  deadline: string; // Recieved as string from form-data

  @ApiPropertyOptional({
    description: 'Estado de la rifa',
    enum: RaffleStatus,
    example: RaffleStatus.DRAFT,
  })
  @IsOptional()
  @IsEnum(RaffleStatus)
  status?: RaffleStatus;

  @ApiPropertyOptional({
    description: 'Tipo de selección de tickets',
    enum: RaffleSelectionType,
    example: RaffleSelectionType.RANDOM,
    default: RaffleSelectionType.RANDOM,
  })
  @IsOptional()
  @IsEnum(RaffleSelectionType)
  selection_type?: RaffleSelectionType;

  // image handled by interceptor, url string added in controller/service
  @ApiPropertyOptional({
    description: 'URL de la imagen (se puede subir archivo o proporcionar URL)',
    example: 'https://example.com/image.jpg',
  })
  image_url?: string;

  @ApiPropertyOptional({
    description:
      'URLs de la galería (se rellenan por el backend al subir archivos en el campo gallery del multipart)',
    type: [String],
    example: [],
  })
  gallery?: string[];

  @ApiPropertyOptional({
    description: 'Estrategia de promoción: nxm (lleva N paga M) o percentage (descuento %)',
    enum: PromotionStrategy,
    example: PromotionStrategy.NXM,
  })
  @IsOptional()
  @IsEnum(PromotionStrategy)
  promotion_strategy?: PromotionStrategy;

  @ApiPropertyOptional({
    description:
      'Configuración de la promoción. NxM: { buy: 5, pay: 4 } o { groups: [{ buy: 3, pay: 2 }, { buy: 5, pay: 4 }] }. Percentage: { percentage: 10 } (10% descuento). En multipart puede enviarse como JSON string.',
    example: { buy: 5, pay: 4 },
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
  @IsObject()
  promotion_config?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Términos y condiciones de la rifa (texto libre)',
  })
  @IsOptional()
  @IsString()
  terms_and_conditions?: string;

  @ApiPropertyOptional({
    description: 'Mostrar barra de progreso en el cliente',
    example: false,
  })
  @IsOptional()
  @Transform(({ obj }) => {
    const raw = obj.show_progress_bar;
    return raw === 'true' || raw === true;
  })
  @IsBoolean()
  show_progress_bar?: boolean;
}
