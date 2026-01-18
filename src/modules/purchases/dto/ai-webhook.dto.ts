import { Allow, IsString, IsUUID } from 'class-validator';
import { PurchaseStatus } from '../entities/purchase.entity';

export class AiWebhookDto {
  @IsUUID()
  purchaseId: string;

  // Accept both backend values (verified/manual_review/...) and worker values (VERIFIED/MANUAL_REVIEW/...)
  @IsString()
  status: PurchaseStatus | string;

  // We accept any JSON payload from the AI worker, but we must keep the property under whitelist:true.
  @Allow()
  aiResult: unknown;
}