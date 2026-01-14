import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Delete,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { PaymentMethodsService } from './payment-methods.service';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';

@Controller('payment-methods')
export class PaymentMethodsController {
  constructor(private readonly paymentMethodsService: PaymentMethodsService) {}

  @Post()
  @AdminAuth()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
    }),
  )
  create(
    @Body() createDto: CreatePaymentMethodDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    // Handle JSON parsing for multipart form data
    if (createDto.payment_data && typeof createDto.payment_data === 'string') {
      try {
        const parsed: unknown = JSON.parse(createDto.payment_data);
        createDto.payment_data = parsed;
      } catch {
        // ignore
      }
    }
    return this.paymentMethodsService.createWithImage(createDto, file);
  }

  @Get()
  findAll() {
    return this.paymentMethodsService.findAll();
  }

  @Get(':uid')
  findOne(@Param('uid') uid: string) {
    return this.paymentMethodsService.findOne(uid);
  }

  @Put(':uid')
  @AdminAuth()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
    }),
  )
  update(
    @Param('uid') uid: string,
    @Body() updateDto: UpdatePaymentMethodDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (updateDto.payment_data && typeof updateDto.payment_data === 'string') {
      try {
        const parsed: unknown = JSON.parse(updateDto.payment_data);
        updateDto.payment_data = parsed;
      } catch {
        // ignore
      }
    }
    return this.paymentMethodsService.updateWithImage(uid, updateDto, file);
  }

  @Delete(':uid')
  @AdminAuth()
  remove(@Param('uid') uid: string) {
    return this.paymentMethodsService.remove(uid);
  }
}
