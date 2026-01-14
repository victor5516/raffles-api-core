import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Currency } from './entities/currency.entity';
import { CreateCurrencyDto } from './dto/create-currency.dto';
import { UpdateCurrencyDto } from './dto/update-currency.dto';

@Injectable()
export class CurrenciesService {
  constructor(
    @InjectRepository(Currency)
    private currencyRepository: Repository<Currency>,
  ) {}

  async create(createDto: CreateCurrencyDto) {
    try {
      const currency = this.currencyRepository.create(createDto);
      return await this.currencyRepository.save(currency);
    } catch (error) {
      if (error.code === '23505') {
        throw new ConflictException('Currency already exists.');
      }
      throw error;
    }
  }

  findAll() {
    return this.currencyRepository.find();
  }

  findOne(uid: string) {
    return this.currencyRepository.findOne({ where: { uid } });
  }

  async update(uid: string, updateDto: UpdateCurrencyDto) {
    await this.currencyRepository.update(uid, updateDto);
    return this.findOne(uid);
  }

  async remove(uid: string) {
    await this.currencyRepository.delete(uid);
  }
}
