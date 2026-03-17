import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentMethod } from './entities/payment-method.entity';
import { Currency } from '../currencies/entities/currency.entity';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';
import { S3Service } from '../../common/s3/s3.service';
import { AuditEventPayload } from '../audit-logs/dto/audit-event.payload';

@Injectable()
export class PaymentMethodsService {
  constructor(
    @InjectRepository(PaymentMethod)
    private paymentMethodRepository: Repository<PaymentMethod>,
    @InjectRepository(Currency)
    private currencyRepository: Repository<Currency>,
    private readonly s3Service: S3Service,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createWithImage(
    createDto: CreatePaymentMethodDto,
    file: Express.Multer.File | undefined,
    adminId: string,
  ) {
    // Validate currency exists
    const currency = await this.currencyRepository.findOne({
      where: { uid: createDto.currency_id },
    });
    if (!currency) {
      throw new BadRequestException('Currency not found');
    }

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
      sheetName: createDto.sheet_name ?? createDto.name,
      accountHolderName: createDto.accountHolderName,
      imageUrl: imageKey,
      paymentData: createDto.payment_data as unknown,
      minimumPaymentAmount: createDto.minimum_payment_amount,
      currencyId: createDto.currency_id,
      order: createDto.order ?? 0,
      aiVerificationEnabled: createDto.ai_verification_enabled ?? true,
      isActive: createDto.is_active ?? true,
      requiredFields: createDto.requiredFields ?? undefined,
    };

    return this.create(entityLike, adminId);
  }

  async create(createDto: Partial<PaymentMethod>, adminId: string) {
    try {
      const paymentMethod = this.paymentMethodRepository.create(createDto);
      const newRecord = await this.paymentMethodRepository.save(paymentMethod);
      this.eventEmitter.emit('audit.log', {
        adminId,
        action: 'CREATE',
        entityName: 'PaymentMethod',
        entityId: newRecord.uid,
        previousData: null,
        newData: newRecord,
      } satisfies AuditEventPayload);
      return newRecord;
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
    const items = await this.paymentMethodRepository.find({
      relations: ['currency'],
      order: { order: 'ASC' },
    });
    return items.map((pm) => {
      const { currency, ...rest } = pm;
      return {
        ...rest,
        currency: currency?.symbol || null,
        imageUrl: this.s3Service.getCdnUrl(pm.imageUrl) ?? pm.imageUrl,
      };
    });
  }

  async findOne(uid: string) {
    const paymentMethod = await this.paymentMethodRepository.findOne({
      where: { uid },
      relations: ['currency'],
    });
    if (!paymentMethod) throw new NotFoundException('Payment method not found');
    const { currency, ...rest } = paymentMethod;
    return {
      ...rest,
      currency: currency?.symbol || null,
      imageUrl:
        this.s3Service.getCdnUrl(paymentMethod.imageUrl) ??
        paymentMethod.imageUrl,
    };
  }

  async update(
    uid: string,
    updateDto: Partial<PaymentMethod>,
    adminId: string,
  ) {
    try {
      const oldData = await this.findOne(uid);
      await this.paymentMethodRepository.update(uid, updateDto);
      const newData = await this.findOne(uid);
      this.eventEmitter.emit('audit.log', {
        adminId,
        action: 'UPDATE',
        entityName: 'PaymentMethod',
        entityId: uid,
        previousData: oldData,
        newData,
      } satisfies AuditEventPayload);
      return newData;
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
    adminId: string,
  ) {
    // Validate currency exists if currency_id is provided
    if (updateDto.currency_id) {
      const currency = await this.currencyRepository.findOne({
        where: { uid: updateDto.currency_id },
      });
      if (!currency) {
        throw new BadRequestException('Currency not found');
      }
    }

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
    if (updateDto.sheet_name !== undefined)
      updateEntityLike.sheetName = updateDto.sheet_name;
    if (updateDto.accountHolderName)
      updateEntityLike.accountHolderName = updateDto.accountHolderName;
    if (imageKey) updateEntityLike.imageUrl = imageKey;
    if (updateDto.payment_data)
      updateEntityLike.paymentData = updateDto.payment_data as unknown;
    if (updateDto.minimum_payment_amount)
      updateEntityLike.minimumPaymentAmount = updateDto.minimum_payment_amount;
    if (updateDto.currency_id)
      updateEntityLike.currencyId = updateDto.currency_id;
    if (updateDto.accountHolderName)
      updateEntityLike.accountHolderName = updateDto.accountHolderName;
    if (updateDto.order !== undefined) updateEntityLike.order = updateDto.order;
    if (updateDto.ai_verification_enabled !== undefined)
      updateEntityLike.aiVerificationEnabled =
        updateDto.ai_verification_enabled;
    if (updateDto.is_active !== undefined)
      updateEntityLike.isActive = updateDto.is_active;
    if (updateDto.requiredFields !== undefined)
      updateEntityLike.requiredFields = updateDto.requiredFields;
    return this.update(uid, updateEntityLike, adminId);
  }

  async remove(uid: string, adminId: string) {
    const oldData = await this.findOne(uid);
    const result = await this.paymentMethodRepository.delete(uid);
    if (result.affected === 0)
      throw new NotFoundException('Payment method not found');
    this.eventEmitter.emit('audit.log', {
      adminId,
      action: 'DELETE',
      entityName: 'PaymentMethod',
      entityId: uid,
      previousData: oldData,
      newData: null,
    } satisfies AuditEventPayload);
  }
}
