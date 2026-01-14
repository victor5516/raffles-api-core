import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseInterceptors,
  UploadedFile,
  Req,
  Query,
} from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { UpdatePurchaseStatusDto } from './dto/update-purchase-status.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import type { Request } from 'express';

@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchasesService: PurchasesService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('payment_screenshot_url', {
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
    @Body() createDto: CreatePurchaseDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    if (file) {
      const protocol = req.protocol;
      const host = req.get('host');
      createDto.payment_screenshot_url = `${protocol}://${host}/uploads/${file.filename}`;
    }

    // Parse customer if string (multipart)
    if (typeof createDto.customer === 'string') {
      try {
        createDto.customer = JSON.parse(createDto.customer);
      } catch (e) {
        // invalid json, validation pipe might catch it later or it stays string
      }
    }

    return this.purchasesService.create(createDto);
  }

  @Get()
  findAll(@Query() query: any) {
    return this.purchasesService.findAll(query);
  }

  @Get(':uid')
  findOne(@Param('uid') uid: string) {
    return this.purchasesService.findOne(uid);
  }

  @Patch(':uid/status')
  updateStatus(
    @Param('uid') uid: string,
    @Body() updateDto: UpdatePurchaseStatusDto,
  ) {
    return this.purchasesService.updateStatus(uid, updateDto);
  }

  @Delete(':uid')
  remove(@Param('uid') uid: string) {
    return this.purchasesService.remove(uid);
  }
}
