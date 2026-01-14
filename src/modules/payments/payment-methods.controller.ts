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
  Req,
} from '@nestjs/common';
import { PaymentMethodsService } from './payment-methods.service';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { Request } from 'express';

@Controller('payment-methods')
export class PaymentMethodsController {
  constructor(private readonly paymentMethodsService: PaymentMethodsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: diskStorage({
        destination: './uploads',
        filename: (req, file, cb) => {
          const randomName = Array(32)
            .fill(null)
            .map(() => Math.round(Math.random() * 16).toString(16))
            .join('');
          cb(null, `${randomName}${extname(file.originalname)}`);
        },
      }),
    }),
  )
  create(
    @Body() createDto: CreatePaymentMethodDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    if (file) {
      const protocol = req.protocol;
      const host = req.get('host');
      createDto.image_url = `${protocol}://${host}/uploads/${file.filename}`;
    }
    // Handle JSON parsing for multipart form data
    if (createDto.payment_data && typeof createDto.payment_data === 'string') {
      try {
        createDto.payment_data = JSON.parse(createDto.payment_data);
      } catch (e) {
        // ignore
      }
    }

    // Explicit mapping to match entity property if DTO uses different name or if transformation is missed
    const entityLike = {
        name: createDto.name,
        imageUrl: createDto.image_url,
        paymentData: createDto.payment_data,
        minimumPaymentAmount: createDto.minimum_payment_amount,
        currency: createDto.currency
    };

    return this.paymentMethodsService.create(entityLike as any);
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
  @UseInterceptors(
    FileInterceptor('image', {
      storage: diskStorage({
        destination: './uploads',
        filename: (req, file, cb) => {
          const randomName = Array(32)
            .fill(null)
            .map(() => Math.round(Math.random() * 16).toString(16))
            .join('');
          cb(null, `${randomName}${extname(file.originalname)}`);
        },
      }),
    }),
  )
  update(
    @Param('uid') uid: string,
    @Body() updateDto: UpdatePaymentMethodDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    if (file) {
      const protocol = req.protocol;
      const host = req.get('host');
      updateDto.image_url = `${protocol}://${host}/uploads/${file.filename}`;
    }
    if (updateDto.payment_data && typeof updateDto.payment_data === 'string') {
      try {
        updateDto.payment_data = JSON.parse(updateDto.payment_data);
      } catch (e) {
        // ignore
      }
    }

    const updateEntityLike: any = {};
    if (updateDto.name) updateEntityLike.name = updateDto.name;
    if (updateDto.image_url) updateEntityLike.imageUrl = updateDto.image_url;
    if (updateDto.payment_data) updateEntityLike.paymentData = updateDto.payment_data;
    if (updateDto.minimum_payment_amount) updateEntityLike.minimumPaymentAmount = updateDto.minimum_payment_amount;
    if (updateDto.currency) updateEntityLike.currency = updateDto.currency;

    return this.paymentMethodsService.update(uid, updateEntityLike);
  }

  @Delete(':uid')
  remove(@Param('uid') uid: string) {
    return this.paymentMethodsService.remove(uid);
  }
}
