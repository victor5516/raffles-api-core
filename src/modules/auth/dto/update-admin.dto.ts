import { IsEmail, MinLength, IsEnum, IsOptional, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AdminRole } from '../enums/admin-role.enum';

export class UpdateAdminDto {
  @ApiProperty({
    description: 'Email del administrador',
    example: 'admin@example.com',
    required: false,
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({
    description: 'Contraseña del administrador (opcional, solo si se desea cambiar)',
    example: 'newpassword123',
    minLength: 6,
    required: false,
  })
  @IsOptional()
  @MinLength(6)
  password?: string;

  @ApiProperty({
    description: 'Nombre completo del administrador',
    example: 'Juan Pérez',
    required: false,
  })
  @IsOptional()
  @IsNotEmpty()
  fullName?: string;

  @ApiProperty({
    description: 'Rol del administrador',
    enum: AdminRole,
    example: AdminRole.VERIFIER,
    required: false,
  })
  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole;
}
