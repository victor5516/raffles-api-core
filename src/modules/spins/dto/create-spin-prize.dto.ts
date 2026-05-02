import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { SpinPrizeType } from '../enums/spin-prize-type.enum';

export class CreateSpinPrizeDto {
  @ApiProperty({
    description: 'Nombre del premio',
    example: '10% de descuento',
  })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({
    description: 'Tipo de premio',
    enum: SpinPrizeType,
    example: SpinPrizeType.COUPON,
  })
  @IsNotEmpty()
  @IsEnum(SpinPrizeType)
  type: SpinPrizeType;

  @ApiProperty({
    description: 'Peso relativo para selección ponderada',
    example: 10,
    minimum: 1,
  })
  @Transform(({ value }) => parseInt(String(value), 10))
  @IsNumber()
  @Min(1)
  weight: number;

  @ApiPropertyOptional({
    description: 'Inventario disponible (null para ilimitado)',
    example: 100,
    minimum: 0,
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === null || value === undefined || value === ''
      ? null
      : parseInt(String(value), 10),
  )
  @IsNumber()
  @Min(0)
  inventory?: number | null;

  @ApiPropertyOptional({
    description: 'Indica si el premio está activo',
    example: true,
    default: true,
  })
  @IsOptional()
  @Transform(({ value, obj }) => {
    const raw = value ?? obj.is_active;
    if (raw === undefined || raw === null) return undefined;
    return raw === true || raw === 'true';
  })
  @IsBoolean()
  isActive?: boolean;
}
