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
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';

@Controller('currencies')
export class CurrenciesController {
  constructor(private readonly currenciesService: CurrenciesService) {}

  @Post()
  @AdminAuth()
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
  @AdminAuth()
  update(@Param('uid') uid: string, @Body() updateDto: UpdateCurrencyDto) {
    return this.currenciesService.update(uid, updateDto);
  }

  @Delete(':uid')
  @AdminAuth()
  remove(@Param('uid') uid: string) {
    return this.currenciesService.remove(uid);
  }
}
