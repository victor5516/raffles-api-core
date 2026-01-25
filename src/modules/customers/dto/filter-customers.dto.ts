import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class FilterCustomersDto {
  @ApiPropertyOptional({
    description: 'Filtrar por número de cédula',
    example: '1234567890',
  })
  @IsOptional()
  @IsString()
  nationalId?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por teléfono',
    example: '+1234567890',
  })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por nombre completo',
    example: 'Juan Pérez',
  })
  @IsOptional()
  @IsString()
  fullName?: string;
}
