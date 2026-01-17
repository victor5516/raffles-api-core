import {
  IsNotEmpty,
  IsString,
  IsNumber,
  Min,
  IsEmail,
  IsOptional,
} from 'class-validator';
import { Transform } from 'class-transformer';

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
  @Transform(({ value }) => parseInt(String(value)))
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

  @IsNotEmpty()
  @Transform(({ value }) => parseFloat(String(value)))
  @IsNumber()
  @Min(0)
  totalAmount: number;

}
