import { IsNotEmpty, IsString, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCurrencyDto {
  @ApiProperty({
    description: 'Nombre de la divisa',
    example: 'Dólar Estadounidense',
  })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({
    description: 'Símbolo de la divisa',
    example: 'USD',
  })
  @IsNotEmpty()
  @IsString()
  symbol: string;

  @ApiProperty({
    description: 'Valor de la divisa (tasa de cambio)',
    example: 1.0,
    type: Number,
    minimum: 0,
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  value: number;
}
