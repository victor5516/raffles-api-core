import { ApiProperty } from '@nestjs/swagger';
import { ReconciliationJobStatus } from '../entities/reconciliation-job.entity';
import { ReconciliationResult } from './reconciliation.dto';

export class ReconciliationJobResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  uid: string;

  @ApiProperty({ example: 'rifa-uid-123' })
  raffleId: string;

  @ApiProperty({ example: 'pago-uid-456' })
  paymentMethodId: string;

  @ApiProperty({ example: 'estado_cuenta_enero.csv', nullable: true })
  fileName: string | null;

  @ApiProperty({ enum: ReconciliationJobStatus })
  status: ReconciliationJobStatus;

  @ApiProperty({ nullable: true, description: 'null mientras status=processing' })
  result: ReconciliationResult | null;

  @ApiProperty({ nullable: true, description: 'null salvo status=failed' })
  errorMessage: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ nullable: true })
  completedAt: Date | null;
}

export class ReconciliationJobCreatedDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  jobId: string;

  @ApiProperty({ enum: ReconciliationJobStatus })
  status: ReconciliationJobStatus;

  @ApiProperty({
    example:
      '/api/v1/purchases/reconcile/jobs/550e8400-e29b-41d4-a716-446655440000',
  })
  statusUrl: string;
}
