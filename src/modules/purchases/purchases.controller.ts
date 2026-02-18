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
  ForbiddenException,
  Res,
  BadRequestException,
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
import { UpdatePurchaseDto } from './dto/update-purchase.dto';
import { UpdatePurchaseStatusDto } from './dto/update-purchase-status.dto';
import { ExportPurchasesDto } from './dto/export-purchases.dto';
import { ExportReceiptsDto } from './dto/export-receipts.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Auth } from '../auth/decorators/admin-auth.decorator';
import { AdminRole } from '../auth/enums/admin-role.enum';
import { ActiveUser } from '../auth/decorators/active-user.decorator';
import { Admin } from '../auth/entities/admin.entity';
import { AiWebhookDto } from './dto/ai-webhook.dto';
import { AuditWebhookDto } from './dto/audit-webhook.dto';
import { ConfigService } from '@nestjs/config';
import { ApiFile } from '../../common/decorators/api-file.decorator';
import { RaffleOrdersSummaryResponseDto } from './dto/purchases-summary.dto';
import { PurchasesCron } from './purchases.cron';
import { ReconciliationService } from './services/reconciliation.service';
import { ReconciliationResult } from './dto/reconciliation.dto';

@ApiTags('Purchases')
@Controller('purchases')
export class PurchasesController {
  constructor(
    private readonly purchasesService: PurchasesService,
    private readonly purchasesCron: PurchasesCron,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly reconciliationService: ReconciliationService,
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

    // Parse ticket_numbers if string (multipart)
    // In multipart/form-data, arrays/objects may arrive as JSON strings
    if (typeof createDto.ticket_numbers === 'string') {
      try {
        const parsed: unknown = JSON.parse(createDto.ticket_numbers);
        createDto.ticket_numbers =
          parsed as CreatePurchaseDto['ticket_numbers'];
      } catch {
        // invalid json, validation pipe might catch it later or it stays string
      }
    }

    return this.purchasesService.create(createDto, file);
  }

  @Get()
  @Auth([AdminRole.VERIFIER, AdminRole.VERIFIER_EXPORT, AdminRole.SUPER_ADMIN])
  @ApiOperation({ summary: 'Obtener todas las compras con filtros opcionales' })
  @ApiBearerAuth('JWT-auth')
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
    name: 'bankReference',
    required: false,
    description: 'Filtrar por referencia bancaria',
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
  @ApiQuery({
    name: 'customerName',
    required: false,
    description: 'Filtrar por nombre del participante',
    type: String,
  })
  @ApiQuery({
    name: 'email',
    required: false,
    description: 'Filtrar por email del participante',
    type: String,
  })
  @ApiQuery({
    name: 'phone',
    required: false,
    description: 'Filtrar por teléfono del participante',
    type: String,
  })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    description: 'Filtrar por fecha desde (formato ISO date)',
    type: String,
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    description: 'Filtrar por fecha hasta (formato ISO date)',
    type: String,
  })
  @ApiQuery({
    name: 'verificationSource',
    required: false,
    description: 'Filtrar por fuente de verificación (ai/admin)',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de compras obtenida exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Permisos insuficientes' })
  findAll(@Query() query: Record<string, unknown>) {
    return this.purchasesService.findAll(query);
  }

  @Post('upload-evidence')
  @Auth([AdminRole.SUPER_ADMIN])
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
    }),
  )
  @ApiOperation({ summary: 'Subir comprobante de pago a S3' })
  @ApiBearerAuth('JWT-auth')
  @ApiConsumes('multipart/form-data')
  @ApiFile('file', true)
  @ApiResponse({
    status: 201,
    description: 'Archivo subido exitosamente. Retorna key y url.',
  })
  @ApiResponse({ status: 400, description: 'Archivo requerido' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Solo Super Admin' })
  async uploadEvidence(@UploadedFile() file: Express.Multer.File) {
    return this.purchasesService.uploadEvidence(file);
  }

  @Post('export')
  @Auth([AdminRole.VERIFIER_EXPORT, AdminRole.SUPER_ADMIN])
  @ApiOperation({ summary: 'Exportar compras a Excel' })
  @ApiBearerAuth('JWT-auth')
  @ApiProduces(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
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

  @Post('export/receipts-pdf')
  @Auth([AdminRole.SUPER_ADMIN])
  @ApiOperation({ summary: 'Exportar comprobantes (imágenes) a PDF' })
  @ApiBearerAuth('JWT-auth')
  @ApiProduces('application/pdf')
  @ApiResponse({
    status: 200,
    description: 'Archivo PDF generado exitosamente',
    content: {
      'application/pdf': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Permisos insuficientes' })
  @ApiResponse({
    status: 404,
    description: 'No se encontraron compras con comprobantes en ese filtro',
  })
  async exportReceiptsPdf(
    @Body() dto: ExportReceiptsDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.purchasesService.generateReceiptsPdf(dto, res);
  }

  @Post('sheets/rebuild')
  @Auth([AdminRole.SUPER_ADMIN])
  @ApiOperation({
    summary: 'Reconstruir Google Sheets de compras desde la base de datos',
    description:
      'Limpia los datos de las pestañas y vuelve a escribir todas las órdenes con la nueva columna UID. Uso recomendado: una sola vez en migración o cuando se necesite resync completo.',
  })
  @ApiBearerAuth('JWT-auth')
  @ApiResponse({
    status: 201,
    description: 'Reconstrucción de sheets ejecutada exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Solo Super Admin' })
  rebuildSheets() {
    return this.purchasesCron.rebuildPurchasesSheets();
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

  @Patch(':uid')
  @UseInterceptors(
    FileInterceptor('payment_screenshot_url', {
      storage: memoryStorage(),
    }),
  )
  @Auth([AdminRole.VERIFIER, AdminRole.VERIFIER_EXPORT, AdminRole.SUPER_ADMIN])
  @ApiOperation({
    summary: 'Actualizar una compra',
    description:
      'Super Admin puede editar todos los campos. Verificadores solo pueden editar el campo notas. Acepta application/json o multipart/form-data para reemplazar el comprobante (solo Super Admin).',
  })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID de la compra a actualizar',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Compra actualizada exitosamente',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({
    status: 403,
    description: 'Verificadores solo pueden actualizar el campo notas',
  })
  @ApiResponse({ status: 404, description: 'Compra no encontrada' })
  async update(
    @Param('uid') uid: string,
    @Body() updateDto: UpdatePurchaseDto,
    @UploadedFile() file?: Express.Multer.File,
    @ActiveUser() user?: Admin,
  ) {
    const isVerifierLike =
      user?.role === AdminRole.VERIFIER ||
      user?.role === AdminRole.VERIFIER_EXPORT;
    if (isVerifierLike) {
      if (file) {
        throw new ForbiddenException('Solo puede actualizar el campo notas.');
      }
      const keysWithValue = (
        Object.keys(updateDto) as (keyof UpdatePurchaseDto)[]
      ).filter((k) => updateDto[k] !== undefined && updateDto[k] !== '');
      const onlyNotes =
        keysWithValue.length === 0 || keysWithValue.every((k) => k === 'notes');
      if (!onlyNotes) {
        throw new ForbiddenException('Solo puede actualizar el campo notas.');
      }
    }

    const dto = updateDto as {
      customer?: unknown;
      ticket_numbers?: unknown;
      payments?: unknown;
    };
    if (typeof dto.customer === 'string') {
      try {
        dto.customer = JSON.parse(dto.customer) as unknown;
      } catch {
        // leave as-is
      }
    }
    if (typeof dto.ticket_numbers === 'string') {
      try {
        dto.ticket_numbers = JSON.parse(dto.ticket_numbers) as number[];
      } catch {
        // leave as-is
      }
    }
    if (typeof dto.payments === 'string') {
      try {
        dto.payments = JSON.parse(dto.payments) as unknown;
      } catch {
        // leave as-is
      }
    }
    return this.purchasesService.update(
      uid,
      updateDto,
      file,
      user?.uid,
      user?.role,
    );
  }

  @Patch(':uid/status')
  @Auth([AdminRole.VERIFIER, AdminRole.VERIFIER_EXPORT, AdminRole.SUPER_ADMIN])
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
  @ApiResponse({ status: 403, description: 'Permisos insuficientes' })
  @ApiResponse({ status: 404, description: 'Compra no encontrada' })
  updateStatus(
    @Param('uid') uid: string,
    @Body() updateDto: UpdatePurchaseStatusDto,
    @ActiveUser() user: Admin,
  ) {
    return this.purchasesService.updateStatus(
      uid,
      updateDto,
      user.role,
      user.uid,
    );
  }

  @Patch(':uid/audit')
  @Auth([AdminRole.VERIFIER, AdminRole.VERIFIER_EXPORT, AdminRole.SUPER_ADMIN])
  @ApiOperation({
    summary: 'Marcar compra como auditada',
    description:
      'Registra que un Admin revisó la aprobación (doble check). Para compras verificadas por IA que ya fueron revisadas por un humano.',
  })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID de la compra a marcar como auditada',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Compra marcada como auditada exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Permisos insuficientes' })
  @ApiResponse({ status: 404, description: 'Compra no encontrada' })
  markAsAudited(@Param('uid') uid: string, @ActiveUser() user: Admin) {
    return this.purchasesService.markAsAudited(uid, user.uid);
  }

  @Delete(':uid')
  @Auth(AdminRole.SUPER_ADMIN)
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
  @ApiResponse({
    status: 403,
    description: 'Solo Super Admin puede eliminar compras',
  })
  @ApiResponse({ status: 404, description: 'Compra no encontrada' })
  remove(@Param('uid') uid: string) {
    return this.purchasesService.remove(uid);
  }

  @Get('summary/by-raffle')
  @Auth([AdminRole.VERIFIER, AdminRole.VERIFIER_EXPORT, AdminRole.SUPER_ADMIN])
  @ApiOperation({
    summary: 'Obtener resumen de órdenes por rifa y currency',
    description:
      'Devuelve el conteo de órdenes pending + manual_review por currency y los totales globales por rifa.',
  })
  @ApiBearerAuth('JWT-auth')
  @ApiQuery({
    name: 'raffleId',
    required: true,
    description: 'UID de la rifa para la que se desea el resumen',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Resumen de órdenes obtenido exitosamente',
    type: RaffleOrdersSummaryResponseDto,
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Permisos insuficientes' })
  getRaffleOrdersSummary(
    @Query('raffleId') raffleId: string,
  ): Promise<RaffleOrdersSummaryResponseDto> {
    return this.purchasesService.getRaffleOrdersSummary(raffleId);
  }

  @Post('webhooks/ai-result')
  @ApiOperation({
    summary: 'Webhook para recibir resultados del análisis de IA',
  })
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
  processAiWebhook(
    @Body() webhook: AiWebhookDto,
    @Headers('x-internal-secret') signature: string,
  ) {
    const aiWebhookSignature = this.configService.getOrThrow<string>(
      'AI_WEBHOOK_SIGNATURE',
    );
    if (!signature || signature !== aiWebhookSignature)
      throw new UnauthorizedException('Signature is required');
    return this.purchasesService.processAiWebhook(webhook);
  }

  @Post('webhooks/audit')
  @UseInterceptors(
    FileInterceptor('payment_screenshot', {
      storage: memoryStorage(),
    }),
  )
  @ApiOperation({
    summary: 'Webhook para crear compras desde auditoría (sistema externo)',
  })
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
    const auditWebhookSignature = this.configService.getOrThrow<string>(
      'AUDIT_WEBHOOK_SIGNATURE',
    );
    if (!signature || signature !== auditWebhookSignature) {
      throw new UnauthorizedException('Signature is required');
    }

    // In multipart/form-data, arrays/objects may arrive as JSON strings
    if (
      typeof (webhook as unknown as { ticket_numbers?: unknown })
        .ticket_numbers === 'string'
    ) {
      try {
        const parsed: unknown = JSON.parse(
          (webhook as unknown as { ticket_numbers: string }).ticket_numbers,
        );
        (webhook as unknown as { ticket_numbers?: unknown }).ticket_numbers =
          parsed;
      } catch {
        // leave as-is; validation/handling will decide
      }
    }

    return this.purchasesService.processAuditWebhook(webhook, file);
  }

  @Post('reconcile')
  @Auth([AdminRole.VERIFIER, AdminRole.VERIFIER_EXPORT, AdminRole.SUPER_ADMIN])
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
    }),
  )
  @ApiOperation({
    summary: 'Conciliación bancaria automática',
    description:
      'Sube un estado de cuenta bancario (Excel/CSV/PDF/imagen), extrae las transacciones de crédito con IA y las cruza contra las compras de un método de pago.',
  })
  @ApiBearerAuth('JWT-auth')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
        paymentMethodId: {
          type: 'string',
          description: 'UID del método de pago a conciliar',
        },
        raffleId: {
          type: 'string',
          description: 'UID de la rifa para filtrar compras',
        },
      },
      required: ['file', 'paymentMethodId', 'raffleId'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Resultado de la conciliación bancaria',
  })
  async reconcile(
    @UploadedFile() file: Express.Multer.File,
    @Body('paymentMethodId') paymentMethodId: string,
    @Body('raffleId') raffleId: string,
  ): Promise<ReconciliationResult> {
    if (!file) {
      throw new BadRequestException('Archivo de estado de cuenta requerido');
    }
    if (!paymentMethodId) {
      throw new BadRequestException('paymentMethodId es requerido');
    }
    if (!raffleId) {
      throw new BadRequestException('raffleId es requerido');
    }

    return this.reconciliationService.reconcile(
      file.buffer,
      file.mimetype,
      paymentMethodId,
      raffleId,
    );
  }

  @Sse('sse/stream')
  @ApiOperation({
    summary: 'Stream de eventos Server-Sent Events para compras',
  })
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
    const purchaseStatusChanged$ = fromEvent(
      this.eventEmitter,
      'purchase.status_changed',
    );

    return merge(purchaseCreated$, purchaseStatusChanged$).pipe(
      map((payload) => ({
        data: JSON.stringify(payload),
      })),
    );
  }
}
