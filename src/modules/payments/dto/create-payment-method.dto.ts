import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { CurrencyType } from '../entities/payment-method.entity';

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
  @IsEnum(CurrencyType)
  currency: CurrencyType;
}
