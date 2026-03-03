# Plan: Carga Asíncrona de Estados de Cuenta (Reconciliation Worker)

> **Verificado contra el código existente — Feb 2026**

## Contexto y problema

El endpoint actual `POST /api/v1/purchases/reconcile` es **síncrono**: recibe el archivo, llama a Gemini AI (múltiples chunks para CSV grandes), realiza el matching y retorna el resultado completo. Para archivos con 200+ transacciones esto puede tomar 30-90 segundos, generando **timeouts HTTP** en el cliente.

### Flujo actual (bloqueante)

```
Cliente                  NestJS                    Gemini AI
  │──POST /reconcile────▶│                          │
  │  ⏳ 30-90 seg         │──parseStatement()───────▶│
  │                       │  (chunking N llamadas)   │
  │                       │◀────────────────────────│
  │                       │──matchTransactions()     │
  │◀──────── result ──────│                          │
```

### Flujo propuesto (asíncrono con EventEmitter2)

```
Cliente            Controller       ReconciliationJobService   ReconciliationJobListener
  │─POST /reconcile──▶│                       │                         │
  │                    │──enqueue()───────────▶│                         │
  │                    │            INSERT job  │                         │
  │                    │            emit('reconciliation.process')───────▶│
  │◀──{ jobId }────────│◀──job(processing)─────│   @OnEvent async        │
  │                    │                        │   reconcile()           │
  │─GET /jobs/:jobId──▶│                        │   UPDATE job(ready)     │
  │◀──{ status, result}│◀───────────────────────│─────────────────────────│
```

---

## Decisiones de diseño

### ¿Por qué EventEmitter2 y no BullMQ/Redis?

El proyecto **ya usa EventEmitter2** (`EventEmitterModule.forRoot()` en `app.module.ts`) con la carpeta `listeners/` y `PurchasesMailListener`. Usar el mismo patrón:
- Es consistente con la arquitectura existente
- No requiere Redis ni dependencias adicionales
- El bottleneck es I/O-bound (HTTP a Gemini): Node.js no bloquea el event loop
- `@OnEvent` con funciones `async` es fire-and-forget: EventEmitter2 llama el handler pero **no awaita** la Promise retornada

### ¿Por qué un Listener separado y no lógica inline en el servicio?

- **Responsabilidades claras**: `ReconciliationJobService` = CRUD del job; Listener = trabajo pesado
- **Consistente con `PurchasesMailListener`**: mismo patrón ya establecido
- **Testeable**: el listener es un `@Injectable()` inyectable con mocks

### ¿Se guarda el archivo en DB?

**No**. Solo se guardan metadatos + resultado (JSONB). El Buffer se pasa in-memory en el evento — aceptable para CSVs de estados de cuenta (< 5 MB por archivo).

---

## Arquitectura de archivos (6 archivos, 1 carpeta nueva)

```
src/
├── migrations/
│   └── 1770900000000-CreateReconciliationJobTable.ts   ← NEW
└── modules/
    └── purchases/
        ├── entities/
        │   └── reconciliation-job.entity.ts             ← NEW
        ├── events/
        │   └── reconciliation.events.ts                 ← NEW (carpeta nueva)
        ├── services/
        │   ├── reconciliation-job.service.ts            ← NEW
        │   └── reconciliation.service.ts                ← SIN CAMBIOS
        ├── listeners/
        │   ├── purchases-mail.listener.ts               ← SIN CAMBIOS
        │   └── reconciliation-job.listener.ts           ← NEW
        ├── dto/
        │   └── reconciliation-job.dto.ts                ← NEW
        ├── purchases.controller.ts                      ← MODIFY
        └── purchases.module.ts                          ← MODIFY
```

---

## Paso 1 — Eventos `reconciliation.events.ts`

**Archivo**: `src/modules/purchases/events/reconciliation.events.ts`

Centraliza los nombres de eventos y las interfaces del payload. Tanto el servicio (emitter) como el listener (receiver) importan desde aquí, evitando magic strings duplicados.

```typescript
export const RECONCILIATION_EVENTS = {
  PROCESS: 'reconciliation.process',
  COMPLETED: 'reconciliation.completed',
  FAILED: 'reconciliation.failed',
} as const;

/** Payload emitido por ReconciliationJobService.enqueue() */
export interface ReconciliationProcessEvent {
  jobId: string;
  fileBuffer: Buffer;
  fileMimeType: string;
  paymentMethodId: string;
  raffleId: string;
}
```

> `COMPLETED` y `FAILED` se reservan para uso futuro (ej. notificaciones SSE). Por ahora solo `PROCESS` se emite activamente.

---

## Paso 2 — Entidad `ReconciliationJob`

**Archivo**: `src/modules/purchases/entities/reconciliation-job.entity.ts`

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ReconciliationResult } from '../dto/reconciliation.dto';

export enum ReconciliationJobStatus {
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

@Entity('reconciliation_jobs')
export class ReconciliationJob {
  @PrimaryGeneratedColumn('uuid')
  uid: string;

  @Column({ name: 'raffle_id' })
  raffleId: string;

  @Column({ name: 'payment_method_id' })
  paymentMethodId: string;

  @Column({ name: 'file_name', nullable: true })
  fileName: string | null;

  @Column({ name: 'file_mime_type', nullable: true })
  fileMimeType: string | null;

  @Column({
    type: 'enum',
    enum: ReconciliationJobStatus,
    default: ReconciliationJobStatus.PROCESSING,
  })
  status: ReconciliationJobStatus;

  @Column({ type: 'jsonb', nullable: true })
  result: ReconciliationResult | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'created_by', nullable: true })
  createdBy: string | null;

  @Column({ name: 'started_at', type: 'timestamp', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

---

## Paso 3 — Migración

**Archivo**: `src/migrations/1770900000000-CreateReconciliationJobTable.ts`

Estilo verificado contra `CreateCouponTable1770800000000` (raw SQL, sin `uuid_generate_v4` — TypeORM genera el UUID en Node.js).

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReconciliationJobTable1770900000000
  implements MigrationInterface
{
  name = 'CreateReconciliationJobTable1770900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."reconciliation_jobs_status_enum"
        AS ENUM ('processing', 'ready', 'failed')
    `);

    await queryRunner.query(`
      CREATE TABLE "reconciliation_jobs" (
        "uid"               UUID        NOT NULL,
        "raffle_id"         VARCHAR     NOT NULL,
        "payment_method_id" VARCHAR     NOT NULL,
        "file_name"         VARCHAR,
        "file_mime_type"    VARCHAR,
        "status"            "public"."reconciliation_jobs_status_enum"
                              NOT NULL DEFAULT 'processing',
        "result"            jsonb,
        "error_message"     text,
        "created_by"        VARCHAR,
        "started_at"        TIMESTAMP,
        "completed_at"      TIMESTAMP,
        "created_at"        TIMESTAMP   NOT NULL DEFAULT now(),
        "updated_at"        TIMESTAMP   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reconciliation_jobs" PRIMARY KEY ("uid")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_reconciliation_jobs_raffle_id"
        ON "reconciliation_jobs" ("raffle_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_reconciliation_jobs_status"
        ON "reconciliation_jobs" ("status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "reconciliation_jobs"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."reconciliation_jobs_status_enum"`,
    );
  }
}
```

---

## Paso 4 — DTOs de respuesta

**Archivo**: `src/modules/purchases/dto/reconciliation-job.dto.ts`

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { ReconciliationJobStatus } from '../entities/reconciliation-job.entity';
import { ReconciliationResult } from './reconciliation.dto';

export class ReconciliationJobResponseDto {
  @ApiProperty()
  uid: string;

  @ApiProperty()
  raffleId: string;

  @ApiProperty()
  paymentMethodId: string;

  @ApiProperty({ nullable: true })
  fileName: string | null;

  @ApiProperty({ enum: ReconciliationJobStatus })
  status: ReconciliationJobStatus;

  @ApiProperty({ nullable: true, description: 'null mientras status=processing' })
  result: ReconciliationResult | null;

  @ApiProperty({ nullable: true, description: 'null salvo status=failed' })
  errorMessage: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ nullable: true })
  completedAt: Date | null;
}

export class ReconciliationJobCreatedDto {
  @ApiProperty()
  jobId: string;

  @ApiProperty({ enum: ReconciliationJobStatus })
  status: ReconciliationJobStatus;

  @ApiProperty({
    example: '/api/v1/purchases/reconcile/jobs/550e8400-e29b-41d4-a716-446655440000',
  })
  statusUrl: string;
}
```

---

## Paso 5 — Servicio `ReconciliationJobService`

**Archivo**: `src/modules/purchases/services/reconciliation-job.service.ts`

Solo gestiona el ciclo de vida del job (CRUD + emit). No ejecuta reconciliación.

```typescript
import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ReconciliationJob,
  ReconciliationJobStatus,
} from '../entities/reconciliation-job.entity';
import { ReconciliationResult } from '../dto/reconciliation.dto';
import {
  RECONCILIATION_EVENTS,
  ReconciliationProcessEvent,
} from '../events/reconciliation.events';

@Injectable()
export class ReconciliationJobService implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationJobService.name);

  constructor(
    @InjectRepository(ReconciliationJob)
    private readonly jobRepo: Repository<ReconciliationJob>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    const stale = await this.markStaleJobsFailed(15);
    if (stale > 0) {
      this.logger.warn(
        `[ReconciliationJob] ${stale} job(s) colgados marcados como FAILED al iniciar`,
      );
    }
  }

  async enqueue(params: {
    fileBuffer: Buffer;
    fileMimeType: string;
    fileName: string | null;
    paymentMethodId: string;
    raffleId: string;
    createdBy: string | null;
  }): Promise<ReconciliationJob> {
    const job = this.jobRepo.create({
      raffleId: params.raffleId,
      paymentMethodId: params.paymentMethodId,
      fileName: params.fileName,
      fileMimeType: params.fileMimeType,
      status: ReconciliationJobStatus.PROCESSING,
      createdBy: params.createdBy,
      startedAt: new Date(),
    });

    const saved = await this.jobRepo.save(job);

    // emit() llama el @OnEvent handler y obtiene una Promise,
    // pero NO la awaita — el handler corre en background (fire-and-forget).
    // Mismo comportamiento que PurchasesService con 'purchase.created'.
    const payload: ReconciliationProcessEvent = {
      jobId: saved.uid,
      fileBuffer: params.fileBuffer,
      fileMimeType: params.fileMimeType,
      paymentMethodId: params.paymentMethodId,
      raffleId: params.raffleId,
    };
    this.eventEmitter.emit(RECONCILIATION_EVENTS.PROCESS, payload);

    this.logger.log(`[ReconciliationJob] Job ${saved.uid} encolado`);
    return saved;
  }

  async markComplete(jobId: string, result: ReconciliationResult): Promise<void> {
    await this.jobRepo.update(jobId, {
      status: ReconciliationJobStatus.READY,
      result,
      completedAt: new Date(),
    });
  }

  async markFailed(jobId: string, errorMessage: string): Promise<void> {
    await this.jobRepo.update(jobId, {
      status: ReconciliationJobStatus.FAILED,
      errorMessage,
      completedAt: new Date(),
    });
  }

  async findOne(uid: string): Promise<ReconciliationJob> {
    const job = await this.jobRepo.findOne({ where: { uid } });
    if (!job) {
      throw new NotFoundException(`Job de conciliación ${uid} no encontrado`);
    }
    return job;
  }

  async findAll(params: {
    raffleId?: string;
    paymentMethodId?: string;
    limit?: number;
  }): Promise<ReconciliationJob[]> {
    const qb = this.jobRepo
      .createQueryBuilder('job')
      .orderBy('job.created_at', 'DESC')
      .take(params.limit ?? 20);

    if (params.raffleId) {
      qb.andWhere('job.raffle_id = :raffleId', { raffleId: params.raffleId });
    }
    if (params.paymentMethodId) {
      qb.andWhere('job.payment_method_id = :pmId', { pmId: params.paymentMethodId });
    }

    return qb.getMany();
  }

  private async markStaleJobsFailed(staleMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
    const result = await this.jobRepo
      .createQueryBuilder()
      .update(ReconciliationJob)
      .set({
        status: ReconciliationJobStatus.FAILED,
        errorMessage: `Marcado automáticamente: sin completar en ${staleMinutes} minutos`,
        completedAt: new Date(),
      })
      .where('status = :status', { status: ReconciliationJobStatus.PROCESSING })
      .andWhere('started_at < :cutoff', { cutoff })
      .execute();
    return result.affected ?? 0;
  }
}
```

---

## Paso 6 — Listener `ReconciliationJobListener`

**Archivo**: `src/modules/purchases/listeners/reconciliation-job.listener.ts`

Patrón idéntico a `purchases-mail.listener.ts`. Importa el nombre del evento y la interfaz del payload desde `events/reconciliation.events.ts`.

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ReconciliationService } from '../services/reconciliation.service';
import { ReconciliationJobService } from '../services/reconciliation-job.service';
import {
  RECONCILIATION_EVENTS,
  ReconciliationProcessEvent,
} from '../events/reconciliation.events';

@Injectable()
export class ReconciliationJobListener {
  private readonly logger = new Logger(ReconciliationJobListener.name);

  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly jobService: ReconciliationJobService,
  ) {}

  @OnEvent(RECONCILIATION_EVENTS.PROCESS)
  async handleReconciliationProcess(
    event: ReconciliationProcessEvent,
  ): Promise<void> {
    const { jobId, fileBuffer, fileMimeType, paymentMethodId, raffleId } = event;

    this.logger.log(
      `[ReconciliationJobListener] Procesando job ${jobId} ` +
        `(raffleId=${raffleId}, paymentMethodId=${paymentMethodId})`,
    );

    try {
      const result = await this.reconciliationService.reconcile(
        fileBuffer,
        fileMimeType,
        paymentMethodId,
        raffleId,
      );

      await this.jobService.markComplete(jobId, result);

      this.logger.log(
        `[ReconciliationJobListener] Job ${jobId} completado: ` +
          `${result.matched.length} matches, ` +
          `${result.unmatchedBank.length} sin match bancario`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';

      await this.jobService.markFailed(jobId, message);

      this.logger.error(
        `[ReconciliationJobListener] Job ${jobId} falló: ${message}`,
      );
    }
  }
}
```

---

## Paso 7 — Modificar `purchases.controller.ts`

### 6.1 — Imports: quitar lo viejo, agregar lo nuevo

```diff
- import { ReconciliationService } from './services/reconciliation.service';
- import { ReconciliationResult } from './dto/reconciliation.dto';
+ import { HttpStatus } from '@nestjs/common';  // agregar HttpStatus a los imports existentes de @nestjs/common
+ import { ReconciliationJobService } from './services/reconciliation-job.service';
+ import {
+   ReconciliationJobCreatedDto,
+   ReconciliationJobResponseDto,
+ } from './dto/reconciliation-job.dto';
+ import { ReconciliationJob } from './entities/reconciliation-job.entity';
```

> `HttpStatus` se agrega a la línea de imports existente de `@nestjs/common`, no es un import nuevo.

### 6.2 — Constructor: reemplazar `reconciliationService`

```diff
  constructor(
    private readonly purchasesService: PurchasesService,
    private readonly purchasesCron: PurchasesCron,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
-   private readonly reconciliationService: ReconciliationService,
+   private readonly reconciliationJobService: ReconciliationJobService,
  ) {}
```

### 6.3 — Reemplazar el endpoint `POST reconcile` (síncrono → asíncrono)

```typescript
@Post('reconcile')
@Auth([AdminRole.VERIFIER, AdminRole.VERIFIER_EXPORT, AdminRole.SUPER_ADMIN])
@UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
@HttpCode(HttpStatus.ACCEPTED)  // ← 202, no 201
@ApiOperation({
  summary: 'Iniciar conciliación bancaria asíncrona',
  description:
    'Encola el archivo para procesamiento en background. ' +
    'Retorna jobId inmediatamente. Consultar GET /reconcile/jobs/:jobId para el resultado.',
})
@ApiBearerAuth('JWT-auth')
@ApiConsumes('multipart/form-data')
@ApiBody({
  schema: {
    type: 'object',
    required: ['file', 'paymentMethodId', 'raffleId'],
    properties: {
      file: { type: 'string', format: 'binary' },
      paymentMethodId: { type: 'string', description: 'UID del método de pago' },
      raffleId: { type: 'string', description: 'UID de la rifa' },
    },
  },
})
@ApiResponse({
  status: 202,
  type: ReconciliationJobCreatedDto,
  description: 'Job iniciado. Consultar statusUrl para el resultado.',
})
async reconcileAsync(
  @UploadedFile() file: Express.Multer.File,
  @Body('paymentMethodId') paymentMethodId: string,
  @Body('raffleId') raffleId: string,
  @ActiveUser() admin: Admin,
): Promise<ReconciliationJobCreatedDto> {
  if (!file) throw new BadRequestException('Archivo requerido');
  if (!paymentMethodId) throw new BadRequestException('paymentMethodId es requerido');
  if (!raffleId) throw new BadRequestException('raffleId es requerido');

  const job = await this.reconciliationJobService.enqueue({
    fileBuffer: file.buffer,
    fileMimeType: file.mimetype,
    fileName: file.originalname ?? null,
    paymentMethodId,
    raffleId,
    createdBy: admin?.uid ?? null,
  });

  return {
    jobId: job.uid,
    status: job.status,
    statusUrl: `/api/v1/purchases/reconcile/jobs/${job.uid}`,
  };
}
```

### 6.4 — Agregar `GET /reconcile/jobs` y `GET /reconcile/jobs/:jobId`

Colocar ANTES del bloque `@Get(':uid')` existente (buena práctica aunque NestJS priorice rutas estáticas).

```typescript
@Get('reconcile/jobs')
@Auth([AdminRole.VERIFIER, AdminRole.VERIFIER_EXPORT, AdminRole.SUPER_ADMIN])
@ApiOperation({ summary: 'Listar historial de jobs de conciliación' })
@ApiBearerAuth('JWT-auth')
@ApiQuery({ name: 'raffleId', required: false })
@ApiQuery({ name: 'paymentMethodId', required: false })
@ApiQuery({ name: 'limit', required: false, type: Number })
@ApiResponse({ status: 200, type: [ReconciliationJobResponseDto] })
listReconciliationJobs(
  @Query('raffleId') raffleId?: string,
  @Query('paymentMethodId') paymentMethodId?: string,
  @Query('limit') limit?: number,
): Promise<ReconciliationJob[]> {
  return this.reconciliationJobService.findAll({ raffleId, paymentMethodId, limit });
}

@Get('reconcile/jobs/:jobId')
@Auth([AdminRole.VERIFIER, AdminRole.VERIFIER_EXPORT, AdminRole.SUPER_ADMIN])
@ApiOperation({
  summary: 'Consultar estado de un job de conciliación',
  description:
    'processing = en curso | ready = resultado disponible | failed = ver errorMessage',
})
@ApiBearerAuth('JWT-auth')
@ApiParam({ name: 'jobId', description: 'UID del job' })
@ApiResponse({ status: 200, type: ReconciliationJobResponseDto })
@ApiResponse({ status: 404, description: 'Job no encontrado' })
getReconciliationJob(
  @Param('jobId') jobId: string,
): Promise<ReconciliationJob> {
  return this.reconciliationJobService.findOne(jobId);
}
```

---

## Paso 8 — Modificar `purchases.module.ts`

```diff
+ import { ReconciliationJob } from './entities/reconciliation-job.entity';
+ import { ReconciliationJobService } from './services/reconciliation-job.service';
+ import { ReconciliationJobListener } from './listeners/reconciliation-job.listener';

  TypeOrmModule.forFeature([
    Purchase, Ticket, Customer, Raffle, PaymentMethod, Currency,
+   ReconciliationJob,
  ]),

  providers: [
    PurchasesService,
    PurchasesExportService,
    PurchaseVerificationService,
    GoogleSheetsService,
    PurchasesCron,
    TicketAllocationService,
    BankStatementParserService,
    ReconciliationService,
+   ReconciliationJobService,
    PurchasesMailListener,
+   ReconciliationJobListener,
  ],
```

---

## Todo List

---

### Fase 0 — Fundación (contratos y persistencia)

> Todo lo demás depende de esta fase. Completar en orden.

- [x] **0.1** Crear carpeta `src/modules/purchases/events/`
- [x] **0.2** Crear `src/modules/purchases/events/reconciliation.events.ts`
  - Exportar `RECONCILIATION_EVENTS` con claves `PROCESS`, `COMPLETED`, `FAILED`
  - Exportar interfaz `ReconciliationProcessEvent` con campos: `jobId`, `fileBuffer`, `fileMimeType`, `paymentMethodId`, `raffleId`
- [x] **0.3** Crear `src/modules/purchases/entities/reconciliation-job.entity.ts`
  - Enum `ReconciliationJobStatus`: `PROCESSING | READY | FAILED`
  - Campos: `uid` (uuid PK), `raffleId`, `paymentMethodId`, `fileName`, `fileMimeType`, `status`, `result` (jsonb nullable), `errorMessage` (text nullable), `createdBy`, `startedAt`, `completedAt`, `createdAt`, `updatedAt`
  - Decoradores TypeORM: `@Entity('reconciliation_jobs')`, `@PrimaryGeneratedColumn('uuid')`, `@CreateDateColumn`, `@UpdateDateColumn`
- [x] **0.4** Crear `src/migrations/1770900000000-CreateReconciliationJobTable.ts`
  - `up`: CREATE TYPE enum + CREATE TABLE + 2 índices (`raffle_id`, `status`)
  - `down`: DROP TABLE + DROP TYPE
  - Sin `DEFAULT uuid_generate_v4()` — TypeORM genera el UUID en Node.js
- [x] **0.5** `synchronize: true` en dev — tabla se crea automáticamente al arrancar la app

---

### Fase 1 — Lógica de negocio (servicio + listener)

> Depende de Fase 0. El servicio y el listener se pueden crear en paralelo.

- [x] **1.1** Crear `src/modules/purchases/services/reconciliation-job.service.ts`
  - Inyectar: `@InjectRepository(ReconciliationJob)`, `EventEmitter2`
  - Implementar `OnModuleInit` → llamar `markStaleJobsFailed(15)` al arrancar
  - Método `enqueue(params)`: `jobRepo.save()` + `eventEmitter.emit(RECONCILIATION_EVENTS.PROCESS, payload)`
  - Método `markComplete(jobId, result)`: `jobRepo.update()` con `status=READY`, `result`, `completedAt`
  - Método `markFailed(jobId, errorMessage)`: `jobRepo.update()` con `status=FAILED`, `errorMessage`, `completedAt`
  - Método `findOne(uid)`: busca por PK, lanza `NotFoundException` si no existe
  - Método `findAll({ raffleId?, paymentMethodId?, limit? })`: QueryBuilder con `ORDER BY created_at DESC`, `TAKE limit ?? 20`, filtros opcionales
  - Método privado `markStaleJobsFailed(minutes)`: UPDATE jobs con `status=PROCESSING` y `started_at < cutoff` → `status=FAILED`
- [x] **1.2** Crear `src/modules/purchases/listeners/reconciliation-job.listener.ts`
  - Inyectar: `ReconciliationService`, `ReconciliationJobService`
  - Importar `RECONCILIATION_EVENTS` y `ReconciliationProcessEvent` desde `events/reconciliation.events.ts`
  - Decorar handler con `@OnEvent(RECONCILIATION_EVENTS.PROCESS)`
  - Handler `async`: llama `reconciliationService.reconcile()` → `jobService.markComplete()` en éxito → `jobService.markFailed()` en catch
  - Logger en inicio, éxito (con conteo de matches) y error

---

### Fase 2 — Capa HTTP (DTOs y controller)

> Depende de Fase 0 (entidad) y Fase 1 (servicio). DTOs y modificación del controller se pueden hacer en paralelo.

- [x] **2.1** Crear `src/modules/purchases/dto/reconciliation-job.dto.ts`
  - Clase `ReconciliationJobResponseDto`: campos `uid`, `raffleId`, `paymentMethodId`, `fileName`, `status`, `result`, `errorMessage`, `createdAt`, `completedAt` con `@ApiProperty`
  - Clase `ReconciliationJobCreatedDto`: campos `jobId`, `status`, `statusUrl` con `@ApiProperty`
- [x] **2.2** Modificar `purchases.controller.ts` — imports
  - Eliminar `import { ReconciliationService }` (ya no lo usa el controller)
  - Eliminar `import { ReconciliationResult }` (ya no lo usa el controller)
  - Agregar `HttpStatus` a los imports existentes de `@nestjs/common`
  - Agregar `import { ReconciliationJobService }`
  - Agregar `import { ReconciliationJobCreatedDto, ReconciliationJobResponseDto }`
  - Agregar `import { ReconciliationJob }`
- [x] **2.3** Modificar `purchases.controller.ts` — constructor
  - Reemplazar `private readonly reconciliationService: ReconciliationService` por `private readonly reconciliationJobService: ReconciliationJobService`
- [x] **2.4** Modificar `purchases.controller.ts` — reemplazar `POST reconcile`
  - Agregar `@HttpCode(HttpStatus.ACCEPTED)` (retorna 202)
  - Cambiar retorno de `ReconciliationResult` a `ReconciliationJobCreatedDto`
  - Llamar `reconciliationJobService.enqueue(...)` en vez de `reconciliationService.reconcile(...)`
  - Retornar `{ jobId, status, statusUrl }`
  - Agregar `@ActiveUser() admin: Admin` al handler para capturar `createdBy`
- [x] **2.5** Modificar `purchases.controller.ts` — agregar `GET reconcile/jobs`
  - Colocar ANTES de `@Get(':uid')` en el archivo
  - `@Auth([VERIFIER, VERIFIER_EXPORT, SUPER_ADMIN])`
  - Queries opcionales: `raffleId`, `paymentMethodId`, `limit`
  - Delega a `reconciliationJobService.findAll(...)`
- [x] **2.6** Modificar `purchases.controller.ts` — agregar `GET reconcile/jobs/:jobId`
  - Colocar ANTES de `@Get(':uid')` en el archivo
  - `@Auth([VERIFIER, VERIFIER_EXPORT, SUPER_ADMIN])`
  - Parámetro `jobId`
  - Delega a `reconciliationJobService.findOne(jobId)`
  - `@ApiResponse({ status: 404 })`

---

### Fase 3 — Wiring del módulo

> Depende de Fase 0, 1 y 2. Un solo archivo a modificar.

- [x] **3.1** Modificar `purchases.module.ts`
  - Agregar import de `ReconciliationJob` en `TypeOrmModule.forFeature([...])`
  - Agregar `ReconciliationJobService` en `providers`
  - Agregar `ReconciliationJobListener` en `providers`
  - No agregar a `exports` (solo lo usa el controller internamente)

---

### Fase 4 — Verificación

> Ejecutar en orden. Cada paso desbloquea el siguiente.(lo hace el usuario manualmente)

- [x] **4.1** Compilación TypeScript sin errores: `npm run build` ✅ — 0 errores
- [ ] **4.2** Levantar servidor en dev: `npm run start:dev` — verificar que no hay errores de DI ni de módulo al arrancar
- [ ] **4.3** Verificar `onModuleInit` en logs: confirmar que aparece `"0 job(s) colgados"` (o N si había jobs de pruebas previas)
- [ ] **4.4** Test del endpoint `POST /api/v1/purchases/reconcile` con Swagger/Postman
  - Subir CSV pequeño (< 10 filas)
  - Verificar respuesta HTTP **202** con body `{ jobId, status: "processing", statusUrl }`
  - Verificar que el response llega en **< 500ms**
- [ ] **4.5** Test de polling `GET /api/v1/purchases/reconcile/jobs/:jobId`
  - Inmediatamente tras el POST → debe retornar `status: "processing"`
  - Tras ~30 segundos → debe retornar `status: "ready"` con `result` poblado
- [ ] **4.6** Test con CSV grande (> 100 filas)
  - Verificar que el POST retorna en < 500ms (sin timeout)
  - Verificar que el job eventualmente llega a `ready`
- [ ] **4.7** Test de error — subir archivo corrupto o formato inválido
  - Verificar que el job queda en `status: "failed"` con `errorMessage` descriptivo
- [ ] **4.8** Test de `GET /api/v1/purchases/reconcile/jobs`
  - Sin filtros → retorna lista de jobs más recientes
  - Con `?raffleId=...` → filtra correctamente
- [ ] **4.9** Verificar logs del listener en cada escenario (inicio, éxito, error)

---

## Flujo de uso desde el frontend

```typescript
// Polling simple (sin SSE)
async function runReconciliation(formData: FormData) {
  const { jobId } = await api.post('/purchases/reconcile', formData);
  // POST retorna 202 inmediatamente

  while (true) {
    await sleep(3000);
    const job = await api.get(`/purchases/reconcile/jobs/${jobId}`);
    if (job.status === 'ready') return job.result;
    if (job.status === 'failed') throw new Error(job.errorMessage);
  }
}
```

---

## Resumen de nuevos endpoints

| Método | Ruta | Status | Descripción |
|--------|------|--------|-------------|
| `POST` | `/api/v1/purchases/reconcile` | 202 | Encola job → retorna `{ jobId }` en <300ms |
| `GET` | `/api/v1/purchases/reconcile/jobs` | 200 | Historial de jobs (más reciente primero) |
| `GET` | `/api/v1/purchases/reconcile/jobs/:jobId` | 200/404 | Estado + resultado de un job |
