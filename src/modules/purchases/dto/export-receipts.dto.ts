import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsUUID } from 'class-validator';

export class ExportReceiptsDto {
  @ApiProperty({
    description: 'UID del método de pago',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  paymentMethodId: string;

  @ApiProperty({
    description: 'Fecha inicial en formato ISO 8601',
    example: '2026-01-01T00:00:00.000Z',
  })
  @Type(() => Date)
  @IsDate()
  startDate: Date;

  @ApiProperty({
    description: 'Fecha final en formato ISO 8601',
    example: '2026-01-31T23:59:59.999Z',
  })
  @Type(() => Date)
  @IsDate()
  endDate: Date;
}
