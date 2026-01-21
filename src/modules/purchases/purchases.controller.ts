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
  Sse,
  MessageEvent,
  Headers,
  UnauthorizedException,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { Observable, fromEvent, map, merge } from 'rxjs';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PurchasesService } from './purchases.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { UpdatePurchaseStatusDto } from './dto/update-purchase-status.dto';
import { ExportPurchasesDto } from './dto/export-purchases.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';
import { AiWebhookDto } from './dto/ai-webhook.dto';
import { ConfigService } from '@nestjs/config';

@Controller('purchases')
export class PurchasesController {
  constructor(
    private readonly purchasesService: PurchasesService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

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

  @Post('export')
  @AdminAuth()
  async exportPurchases(
    @Body() exportDto: ExportPurchasesDto,
    @Res() res: Response,
  ) {
    const buffer = await this.purchasesService.exportPurchases(exportDto);

    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `ordenes-${exportDto.currency || 'todas'}-${timestamp}.xlsx`;

    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });

    res.send(buffer);
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

  @Post('webhooks/ai-result')
  processAiWebhook(@Body() webhook: AiWebhookDto, @Headers('x-internal-secret') signature: string) {
    const aiWebhookSignature = this.configService.getOrThrow<string>('AI_WEBHOOK_SIGNATURE');
    if (!signature || signature !== aiWebhookSignature) throw new UnauthorizedException('Signature is required');
    return this.purchasesService.processAiWebhook(webhook);
  }

  @Post('migrate-tickets')
  @AdminAuth()
  migrateTickets() {
    return this.purchasesService.migrateTickets();
  }

  @Sse('sse/stream')
  sseStream(): Observable<MessageEvent> {
    const purchaseCreated$ = fromEvent(this.eventEmitter, 'purchase.created');
    const purchaseStatusChanged$ = fromEvent(this.eventEmitter, 'purchase.status_changed');

    return merge(purchaseCreated$, purchaseStatusChanged$).pipe(
      map((payload) => ({
        data: JSON.stringify(payload),
      })),
    );
  }
}
