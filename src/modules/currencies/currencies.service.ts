import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Currency } from './entities/currency.entity';
import { CreateCurrencyDto } from './dto/create-currency.dto';
import { UpdateCurrencyDto } from './dto/update-currency.dto';
import { AuditEventPayload } from '../audit-logs/dto/audit-event.payload';

@Injectable()
export class CurrenciesService {
  constructor(
    @InjectRepository(Currency)
    private currencyRepository: Repository<Currency>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(createDto: CreateCurrencyDto, adminId: string) {
    try {
      const currency = this.currencyRepository.create(createDto);
      const newRecord = await this.currencyRepository.save(currency);
      this.eventEmitter.emit('audit.log', {
        adminId,
        action: 'CREATE',
        entityName: 'Currency',
        entityId: newRecord.uid,
        previousData: null,
        newData: newRecord,
      } satisfies AuditEventPayload);
      return newRecord;
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === '23505') {
        throw new ConflictException('Currency already exists.');
      }
      throw error;
    }
  }

  findAll() {
    return this.currencyRepository.find();
  }

  async findOne(uid: string) {
    return this.currencyRepository.findOne({ where: { uid } });
  }

  async update(uid: string, updateDto: UpdateCurrencyDto, adminId: string) {
    const oldData = await this.findOne(uid);
    await this.currencyRepository.update(uid, updateDto);
    const newData = await this.findOne(uid);
    this.eventEmitter.emit('audit.log', {
      adminId,
      action: 'UPDATE',
      entityName: 'Currency',
      entityId: uid,
      previousData: oldData,
      newData,
    } satisfies AuditEventPayload);
    return newData;
  }

  async remove(uid: string, adminId: string) {
    const oldData = await this.findOne(uid);
    await this.currencyRepository.delete(uid);
    this.eventEmitter.emit('audit.log', {
      adminId,
      action: 'DELETE',
      entityName: 'Currency',
      entityId: uid,
      previousData: oldData,
      newData: null,
    } satisfies AuditEventPayload);
  }
}
