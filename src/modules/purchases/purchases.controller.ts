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
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiQuery,
  ApiHeader,
  ApiProduces,
} from '@nestjs/swagger';
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
import { AuditWebhookDto } from './dto/audit-webhook.dto';
import { ConfigService } from '@nestjs/config';
import { ApiFile } from '../../common/decorators/api-file.decorator';

@ApiTags('Purchases')
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
  @ApiOperation({ summary: 'Crear una nueva compra' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreatePurchaseDto })
  @ApiFile('payment_screenshot_url', false)
  @ApiResponse({
    status: 201,
    description: 'Compra creada exitosamente',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
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
  @ApiOperation({ summary: 'Obtener todas las compras con filtros opcionales' })
  @ApiQuery({
    name: 'raffleId',
    required: false,
    description: 'Filtrar por UID de rifa',
    type: String,
  })
  @ApiQuery({
    name: 'currency',
    required: false,
    description: 'Filtrar por símbolo de divisa',
    type: String,
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filtrar por estado',
    type: String,
  })
  @ApiQuery({
    name: 'nationalId',
    required: false,
    description: 'Filtrar por cédula del cliente',
    type: String,
  })
  @ApiQuery({
    name: 'paymentMethodId',
    required: false,
    description: 'Filtrar por UID del método de pago',
    type: String,
  })
  @ApiQuery({
    name: 'ticketNumber',
    required: false,
    description: 'Filtrar por número de ticket',
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de compras obtenida exitosamente',
  })
  findAll(@Query() query: Record<string, unknown>) {
    return this.purchasesService.findAll(query);
  }

  @Post('export')
  @AdminAuth()
  @ApiOperation({ summary: 'Exportar compras a Excel' })
  @ApiBearerAuth('JWT-auth')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({
    status: 200,
    description: 'Archivo Excel generado exitosamente',
    content: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
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
  @ApiOperation({ summary: 'Obtener una compra por su UID' })
  @ApiParam({
    name: 'uid',
    description: 'UID de la compra',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Compra encontrada',
  })
  @ApiResponse({ status: 404, description: 'Compra no encontrada' })
  findOne(@Param('uid') uid: string) {
    return this.purchasesService.findOne(uid);
  }

  @Patch(':uid/status')
  @AdminAuth()
  @ApiOperation({ summary: 'Actualizar el estado de una compra' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID de la compra a actualizar',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Estado de compra actualizado exitosamente',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Compra no encontrada' })
  updateStatus(
    @Param('uid') uid: string,
    @Body() updateDto: UpdatePurchaseStatusDto,
  ) {
    return this.purchasesService.updateStatus(uid, updateDto);
  }

  @Delete(':uid')
  @AdminAuth()
  @ApiOperation({ summary: 'Eliminar una compra' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID de la compra a eliminar',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Compra eliminada exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 404, description: 'Compra no encontrada' })
  remove(@Param('uid') uid: string) {
    return this.purchasesService.remove(uid);
  }

  @Post('webhooks/ai-result')
  @ApiOperation({ summary: 'Webhook para recibir resultados del análisis de IA' })
  @ApiHeader({
    name: 'x-internal-secret',
    description: 'Firma secreta para autenticar el webhook',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Webhook procesado exitosamente',
  })
  @ApiResponse({ status: 401, description: 'Firma inválida o faltante' })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  processAiWebhook(@Body() webhook: AiWebhookDto, @Headers('x-internal-secret') signature: string) {
    const aiWebhookSignature = this.configService.getOrThrow<string>('AI_WEBHOOK_SIGNATURE');
    if (!signature || signature !== aiWebhookSignature) throw new UnauthorizedException('Signature is required');
    return this.purchasesService.processAiWebhook(webhook);
  }

  @Post('webhooks/audit')
  @UseInterceptors(
    FileInterceptor('payment_screenshot', {
      storage: memoryStorage(),
    }),
  )
  @ApiOperation({ summary: 'Webhook para crear compras desde auditoría (sistema externo)' })
  @ApiHeader({
    name: 'x-internal-secret',
    description: 'Firma secreta para autenticar el webhook',
    required: true,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: AuditWebhookDto })
  @ApiFile('payment_screenshot', false)
  @ApiResponse({
    status: 201,
    description: 'Webhook de auditoría procesado exitosamente',
  })
  @ApiResponse({ status: 401, description: 'Firma inválida o faltante' })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  async processAuditWebhook(
    @Body() webhook: AuditWebhookDto,
    @UploadedFile() file: Express.Multer.File,
    @Headers('x-internal-secret') signature: string,
  ) {
    const auditWebhookSignature =
      this.configService.getOrThrow<string>('AUDIT_WEBHOOK_SIGNATURE');
    if (!signature || signature !== auditWebhookSignature) {
      throw new UnauthorizedException('Signature is required');
    }

    // In multipart/form-data, arrays/objects may arrive as JSON strings
    if (typeof (webhook as unknown as { ticket_numbers?: unknown }).ticket_numbers === 'string') {
      try {
        const parsed: unknown = JSON.parse(
          (webhook as unknown as { ticket_numbers: string }).ticket_numbers,
        );
        (webhook as unknown as { ticket_numbers?: unknown }).ticket_numbers = parsed;
      } catch {
        // leave as-is; validation/handling will decide
      }
    }

    return this.purchasesService.processAuditWebhook(webhook, file);
  }

  @Sse('sse/stream')
  @ApiOperation({ summary: 'Stream de eventos Server-Sent Events para compras' })
  @ApiResponse({
    status: 200,
    description: 'Stream de eventos activo',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
        },
      },
    },
  })
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
