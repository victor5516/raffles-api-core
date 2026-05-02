import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class ListCustomerSpinsDto {
  @ApiProperty({
    description: 'Customer ID para consultar giros disponibles',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsNotEmpty()
  @IsUUID()
  customerId: string;
}
