import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    description: 'Email del administrador',
    example: 'admin@example.com',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    description: 'Contraseña del administrador',
    example: 'password123',
    minLength: 6,
  })
  @IsNotEmpty()
  @MinLength(6)
  password: string;
}
