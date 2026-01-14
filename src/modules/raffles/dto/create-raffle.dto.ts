import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsEnum,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { RaffleStatus } from '../entities/raffle.entity';

export class CreateRaffleDto {
  @IsNotEmpty()
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(String(value)))
  @IsNumber()
  digits_length: number;

  @IsNotEmpty()
  @Transform(({ value }) => parseFloat(String(value)))
  @IsNumber()
  @Min(0)
  ticket_price: number;

  @IsNotEmpty()
  @Transform(({ value }) => parseInt(String(value)))
  @IsNumber()
  @Min(1)
  total_tickets: number;

  @IsNotEmpty()
  @IsDateString()
  deadline: string; // Recieved as string from form-data

  @IsOptional()
  @IsEnum(RaffleStatus)
  status?: RaffleStatus;

  // image handled by interceptor, url string added in controller/service
  image_url?: string;
}
