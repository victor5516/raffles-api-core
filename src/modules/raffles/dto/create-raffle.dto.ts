import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsEnum,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RaffleStatus, RaffleSelectionType } from '../entities/raffle.entity';

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
}
