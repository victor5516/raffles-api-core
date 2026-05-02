import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class GeneratePromoLinksDto {
  @ApiProperty({
    description: 'Cantidad de tokens promocionales a generar',
    example: 25,
    minimum: 1,
    maximum: 5000,
  })
  @Transform(({ value }) => parseInt(String(value), 10))
  @IsInt()
  @Min(1)
  @Max(5000)
  quantity: number;
}
