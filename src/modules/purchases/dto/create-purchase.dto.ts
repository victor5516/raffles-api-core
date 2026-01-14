import {
  IsNotEmpty,
  IsString,
  IsNumber,
  Min,
  IsUUID,
  IsEmail,
  IsOptional,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class CustomerDto {
  @IsNotEmpty()
  @IsString()
  national_id: string;

  @IsNotEmpty()
  @IsString()
  full_name: string;

  @IsNotEmpty()
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class CreatePurchaseDto {
  @IsNotEmpty()
  @IsString() // ID
  raffleId: string;

  @IsNotEmpty()
  @IsString() // ID
  paymentMethodId: string;

  @IsNotEmpty()
  @Transform(({ value }) => parseInt(value))
  @IsNumber()
  @Min(1)
  ticket_quantity: number;

  @IsNotEmpty()
  @IsString()
  bank_reference: string;

  // customer is received as JSON string in multipart form
  @IsNotEmpty()
  customer: CustomerDto;

  // payment_screenshot_url handled by interceptor
  payment_screenshot_url?: string;
}
