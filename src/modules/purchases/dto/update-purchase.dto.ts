import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdatePurchaseDto {
  @ApiProperty({
    description: 'Notas de la compra',
    required: false,
    example: 'Cliente contactado, pago verificado manualmente',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
