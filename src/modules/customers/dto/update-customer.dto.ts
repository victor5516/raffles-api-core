import { IsOptional, IsString, IsEmail } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateCustomerDto {
  @ApiPropertyOptional({
    description: 'Número de cédula del cliente',
    example: '1234567890',
  })
  @IsOptional()
  @IsString()
  nationalId?: string;

  @ApiPropertyOptional({
    description: 'Nombre completo del cliente',
    example: 'Juan Pérez',
  })
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiPropertyOptional({
    description: 'Email del cliente',
    example: 'juan.perez@example.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: 'Teléfono del cliente',
    example: '+1234567890',
  })
  @IsOptional()
  @IsString()
  phone?: string;
}
