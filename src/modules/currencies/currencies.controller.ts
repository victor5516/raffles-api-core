import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { CurrenciesService } from './currencies.service';
import { CreateCurrencyDto } from './dto/create-currency.dto';
import { UpdateCurrencyDto } from './dto/update-currency.dto';

@Controller('currencies')
export class CurrenciesController {
  constructor(private readonly currenciesService: CurrenciesService) {}

  @Post()
  create(@Body() createDto: CreateCurrencyDto) {
    return this.currenciesService.create(createDto);
  }

  @Get()
  findAll() {
    return this.currenciesService.findAll();
  }

  @Get(':uid')
  findOne(@Param('uid') uid: string) {
    return this.currenciesService.findOne(uid);
  }

  @Patch(':uid')
  update(@Param('uid') uid: string, @Body() updateDto: UpdateCurrencyDto) {
    return this.currenciesService.update(uid, updateDto);
  }

  @Delete(':uid')
  remove(@Param('uid') uid: string) {
    return this.currenciesService.remove(uid);
  }
}
