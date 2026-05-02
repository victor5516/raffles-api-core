import { PartialType } from '@nestjs/swagger';
import { CreateSpinPrizeDto } from './create-spin-prize.dto';

export class UpdateSpinPrizeDto extends PartialType(CreateSpinPrizeDto) {}
