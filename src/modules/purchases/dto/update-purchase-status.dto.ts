import { IsNotEmpty, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PurchaseStatus } from '../entities/purchase.entity';

export class UpdatePurchaseStatusDto {
  @ApiProperty({
    description: 'Nuevo estado de la compra',
    enum: PurchaseStatus,
    example: PurchaseStatus.VERIFIED,
  })
  @IsNotEmpty()
  @IsEnum(PurchaseStatus)
  status: PurchaseStatus;
}
