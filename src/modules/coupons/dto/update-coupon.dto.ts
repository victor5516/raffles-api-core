import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsOptional } from 'class-validator';

export class UpdateCouponDto {
  @ApiPropertyOptional({ description: 'Activar o desactivar el cupón' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Nueva fecha de expiración ISO 8601',
    example: '2026-12-31T23:59:59Z',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
