import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsISO8601, IsNotEmpty, Max, Min } from 'class-validator';

export class GenerateCouponsDto {
  @ApiProperty({
    description: 'Cantidad de cupones a generar',
    example: 50,
    minimum: 1,
    maximum: 10000,
  })
  @IsInt()
  @Min(1)
  @Max(10000)
  count: number;

  @ApiProperty({
    description: 'Fecha de expiración ISO 8601',
    example: '2026-06-30T23:59:59Z',
  })
  @IsISO8601()
  @IsNotEmpty()
  expiresAt: string;
}
