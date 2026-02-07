import { IsOptional, IsString, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { VENEZUELA_STATES } from '../../../common/constants/locations.constant';

/**
 * DTO para el objeto location (JSONB) del cliente.
 * Valida state contra estados de Venezuela; city, address y otros campos son opcionales y flexibles.
 */
export class CustomerLocationDto {
  @ApiPropertyOptional({
    description: 'Estado de Venezuela',
    example: 'Táchira',
    enum: VENEZUELA_STATES,
  })
  @IsOptional()
  @IsString()
  @IsIn(VENEZUELA_STATES, {
    message: `state debe ser uno de: ${VENEZUELA_STATES.join(', ')}`,
  })
  state?: string;

  @ApiPropertyOptional({
    description: 'Ciudad o localidad',
    example: 'San Cristóbal',
  })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({
    description: 'Dirección o referencia',
    example: 'Av. Principal, Edificio X',
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({
    description: 'Código postal',
    example: '5001',
  })
  @IsOptional()
  @IsString()
  zip?: string;
}
