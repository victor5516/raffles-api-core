import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import { CreateRaffleDto } from './create-raffle.dto';

export class UpdateRaffleDto extends PartialType(CreateRaffleDto) {
  @ApiPropertyOptional({
    description:
      'JSON array of S3 keys to remove from gallery (deleted from bucket and DB)',
    example: '["raffles/uid/abc.jpg"]',
  })
  @IsOptional()
  @IsString()
  gallery_keys_to_delete?: string;
}
