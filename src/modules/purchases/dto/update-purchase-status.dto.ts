import { IsNotEmpty, IsEnum } from 'class-validator';
import { PurchaseStatus } from '../entities/purchase.entity';

export class UpdatePurchaseStatusDto {
  @IsNotEmpty()
  @IsEnum(PurchaseStatus)
  status: PurchaseStatus;
}
