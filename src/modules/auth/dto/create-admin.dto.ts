import { IsEmail, IsNotEmpty, MinLength, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AdminRole } from '../enums/admin-role.enum';

export class CreateAdminDto {
  @ApiProperty({
    description: 'Email del administrador',
    example: 'admin@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: 'Contraseña del administrador',
    example: 'password123',
    minLength: 6,
  })
  @IsNotEmpty()
  @MinLength(6)
  password: string;

  @ApiProperty({
    description: 'Nombre completo del administrador',
    example: 'Juan Pérez',
  })
  @IsNotEmpty()
  fullName: string;

  @ApiProperty({
    description: 'Rol del administrador',
    enum: AdminRole,
    example: AdminRole.VERIFIER,
    default: AdminRole.VERIFIER,
  })
  @IsEnum(AdminRole)
  @IsNotEmpty()
  role: AdminRole;
}
