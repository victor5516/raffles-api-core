import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaymentMethod } from './entities/payment-method.entity';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';

@Injectable()
export class PaymentMethodsService {
  constructor(
    @InjectRepository(PaymentMethod)
    private paymentMethodRepository: Repository<PaymentMethod>,
  ) {}

  async create(createDto: CreatePaymentMethodDto) {
    try {
      const paymentMethod = this.paymentMethodRepository.create(createDto);
      return await this.paymentMethodRepository.save(paymentMethod);
    } catch (error) {
      if (error.code === '23505') {
        // Postgres unique violation
        throw new ConflictException(
          'A payment method with this name already exists.',
        );
      }
      throw error;
    }
  }

  findAll() {
    return this.paymentMethodRepository.find();
  }

  async findOne(uid: string) {
    const paymentMethod = await this.paymentMethodRepository.findOne({
      where: { uid },
    });
    if (!paymentMethod) throw new NotFoundException('Payment method not found');
    return paymentMethod;
  }

  async update(uid: string, updateDto: UpdatePaymentMethodDto) {
    try {
      await this.paymentMethodRepository.update(uid, updateDto);
      return this.findOne(uid);
    } catch (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          'A payment method with this name already exists.',
        );
      }
      throw error;
    }
  }

  async remove(uid: string) {
    const result = await this.paymentMethodRepository.delete(uid);
    if (result.affected === 0)
      throw new NotFoundException('Payment method not found');
  }
}
