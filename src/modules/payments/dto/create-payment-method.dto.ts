import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsUUID,
  IsOptional,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class CreatePaymentMethodDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsOptional()
  image_url?: string;

  @IsNotEmpty()
  payment_data: any;

  @IsNotEmpty()
  @Transform(({ value }) => parseFloat(String(value)))
  @IsNumber()
  minimum_payment_amount: number;

  @IsNotEmpty()
  @IsUUID()
  currency_id: string;
}
