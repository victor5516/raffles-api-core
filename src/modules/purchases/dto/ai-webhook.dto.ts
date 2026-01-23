import { Allow, IsString, IsUUID, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PurchaseStatus } from '../entities/purchase.entity';

export class AiWebhookDto {
  @ApiProperty({
    description: 'UID de la compra a procesar',
    example: '123e4567-e89b-12d3-a456-426614174000',
    format: 'uuid',
  })
  @IsUUID()
  purchaseId: string;

  @ApiPropertyOptional({
    description: 'Estado sugerido por la IA (opcional)',
    example: 'verified',
  })
  // Accept both backend values (verified/manual_review/...) and worker values (VERIFIED/MANUAL_REVIEW/...)
  @IsOptional()
  @IsString()
  status?: PurchaseStatus | string;

  @ApiProperty({
    description: 'Resultado del análisis de IA (cualquier estructura JSON)',
    example: { confidence: 0.95, detected_amount: 50.0 },
  })
  // We accept any JSON payload from the AI worker, but we must keep the property under whitelist:true.
  @Allow()
  aiResult: unknown;
}
