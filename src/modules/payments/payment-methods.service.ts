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
import { S3Service } from '../../common/s3/s3.service';

@Injectable()
export class PaymentMethodsService {
  constructor(
    @InjectRepository(PaymentMethod)
    private paymentMethodRepository: Repository<PaymentMethod>,
    private readonly s3Service: S3Service,
  ) {}

  async createWithImage(
    createDto: CreatePaymentMethodDto,
    file: Express.Multer.File | undefined,
  ) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');

    const imageKey = file
      ? (
          await this.s3Service.uploadBuffer({
            keyPrefix: `payment-methods/${year}/${month}`,
            originalName: file.originalname,
            buffer: file.buffer,
            contentType: file.mimetype,
          })
        ).key
      : createDto.image_url;

    const entityLike: Partial<PaymentMethod> = {
      name: createDto.name,
      imageUrl: imageKey,
      paymentData: createDto.payment_data as unknown,
      minimumPaymentAmount: createDto.minimum_payment_amount,
      currency: createDto.currency,
    };

    return this.create(entityLike);
  }

  async create(createDto: Partial<PaymentMethod>) {
    try {
      const paymentMethod = this.paymentMethodRepository.create(createDto);
      return await this.paymentMethodRepository.save(paymentMethod);
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === '23505') {
        // Postgres unique violation
        throw new ConflictException(
          'A payment method with this name already exists.',
        );
      }
      throw error;
    }
  }

  async findAll() {
    const items = await this.paymentMethodRepository.find();
    return await Promise.all(
      items.map(async (pm) => ({
        ...pm,
        imageUrl:
          (await this.s3Service.getPresignedGetUrl(pm.imageUrl)) ?? pm.imageUrl,
      })),
    );
  }

  async findOne(uid: string) {
    const paymentMethod = await this.paymentMethodRepository.findOne({
      where: { uid },
    });
    if (!paymentMethod) throw new NotFoundException('Payment method not found');
    return {
      ...paymentMethod,
      imageUrl:
        (await this.s3Service.getPresignedGetUrl(paymentMethod.imageUrl)) ??
        paymentMethod.imageUrl,
    };
  }

  async update(uid: string, updateDto: Partial<PaymentMethod>) {
    try {
      await this.paymentMethodRepository.update(uid, updateDto);
      return this.findOne(uid);
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === '23505') {
        throw new ConflictException(
          'A payment method with this name already exists.',
        );
      }
      throw error;
    }
  }

  async updateWithImage(
    uid: string,
    updateDto: UpdatePaymentMethodDto,
    file: Express.Multer.File | undefined,
  ) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');

    const imageKey = file
      ? (
          await this.s3Service.uploadBuffer({
            keyPrefix: `payment-methods/${year}/${month}`,
            originalName: file.originalname,
            buffer: file.buffer,
            contentType: file.mimetype,
          })
        ).key
      : updateDto.image_url;

    const updateEntityLike: Partial<PaymentMethod> = {};
    if (updateDto.name) updateEntityLike.name = updateDto.name;
    if (imageKey) updateEntityLike.imageUrl = imageKey;
    if (updateDto.payment_data)
      updateEntityLike.paymentData = updateDto.payment_data as unknown;
    if (updateDto.minimum_payment_amount)
      updateEntityLike.minimumPaymentAmount = updateDto.minimum_payment_amount;
    if (updateDto.currency) updateEntityLike.currency = updateDto.currency;

    return this.update(uid, updateEntityLike);
  }

  async remove(uid: string) {
    const result = await this.paymentMethodRepository.delete(uid);
    if (result.affected === 0)
      throw new NotFoundException('Payment method not found');
  }
}
