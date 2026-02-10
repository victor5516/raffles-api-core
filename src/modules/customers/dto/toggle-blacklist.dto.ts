import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class ToggleBlacklistDto {
  @ApiProperty({
    description: 'Si el cliente debe estar bloqueado',
    example: true,
  })
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isBlacklisted: boolean;

  @ApiPropertyOptional({
    description: 'Razón del bloqueo',
    example: 'Compras fraudulentas repetidas',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
