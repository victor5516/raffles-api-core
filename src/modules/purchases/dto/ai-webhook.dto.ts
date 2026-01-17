import { PurchaseStatus } from "../entities/purchase.entity";

export class AiWebhookDto {
    purchaseId: string;
    status: PurchaseStatus;
    aiResult: unknown;
  }