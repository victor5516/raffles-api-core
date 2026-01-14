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
  Query,
} from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { UpdatePurchaseStatusDto } from './dto/update-purchase-status.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';

@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchasesService: PurchasesService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('payment_screenshot_url', {
      storage: memoryStorage(),
    }),
  )
  async create(
    @Body() createDto: CreatePurchaseDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    // Parse customer if string (multipart)
    if (typeof createDto.customer === 'string') {
      try {
        const parsed: unknown = JSON.parse(createDto.customer);
        createDto.customer = parsed as CreatePurchaseDto['customer'];
      } catch {
        // invalid json, validation pipe might catch it later or it stays string
      }
    }

    return this.purchasesService.create(createDto, file);
  }

  @Get()
  findAll(@Query() query: Record<string, unknown>) {
    return this.purchasesService.findAll(query);
  }

  @Get(':uid')
  findOne(@Param('uid') uid: string) {
    return this.purchasesService.findOne(uid);
  }

  @Patch(':uid/status')
  @AdminAuth()
  updateStatus(
    @Param('uid') uid: string,
    @Body() updateDto: UpdatePurchaseStatusDto,
  ) {
    return this.purchasesService.updateStatus(uid, updateDto);
  }

  @Delete(':uid')
  @AdminAuth()
  remove(@Param('uid') uid: string) {
    return this.purchasesService.remove(uid);
  }
}
