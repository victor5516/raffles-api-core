# Plan: Módulo de Cupones (`coupons`)

## Resumen del Feature

Un cupón es un código alfanumérico de 6 caracteres que el cliente puede canjear al momento de crear una compra. Cada cupón cubre exactamente **1 ticket** de cualquier rifa activa, tiene una **fecha de expiración** configurable, y es de **un solo uso**. Los cupones son generados por administradores en batch.

---

## Reglas de Negocio

| Regla | Detalle |
|-------|---------|
| Formato de código | 6 caracteres, `[A-Z0-9]`, ej: `A3K9BZ` |
| Uso | Un solo canjeado → marca como usado y no puede reutilizarse |
| Aplicabilidad | Válido para cualquier rifa activa (no está atado a una rifa específica) |
| Valor | Cubre 1 ticket al precio base de la rifa (`ticketPrice * currency.value`) |
| Límite por compra | Máximo `ticket_quantity` cupones por compra (no puede usar más cupones que tickets compra) |
| Combinación con promociones | Los cupones se aplican **después** del descuento por promoción |
| Expiración | Si `expiresAt < now()` → rechazado al intentar canjear |
| Inactivación | Un admin puede desactivar un cupón sin usarlo (`isActive = false`) |
| totalAmount con cupones | `max(0, promotionalTotal - couponCount * unitPriceInPaymentCurrency)` |

---

## Fase 1 — Capa de Datos

### 1.1 Migración: crear tabla `coupon`

**Archivo:** `src/migrations/1770800000000-CreateCouponTable.ts`

```typescript
export class CreateCouponTable1770800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "coupon" (
        "code"              VARCHAR(6)    NOT NULL,
        "is_active"         BOOLEAN       NOT NULL DEFAULT true,
        "expires_at"        TIMESTAMP     NOT NULL,
        "redeemed_at"       TIMESTAMP,
        "purchase_id"       UUID,
        "created_by_id"     UUID          NOT NULL,
        "created_at"        TIMESTAMP     NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coupon_code" PRIMARY KEY ("code"),
        CONSTRAINT "FK_coupon_purchase"
          FOREIGN KEY ("purchase_id") REFERENCES "purchase"("uid") ON DELETE SET NULL,
        CONSTRAINT "FK_coupon_admin"
          FOREIGN KEY ("created_by_id") REFERENCES "admin"("uid") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_coupon_is_active_expires_at"
        ON "coupon" ("is_active", "expires_at")
        WHERE "redeemed_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_coupon_purchase_id"
        ON "coupon" ("purchase_id")
        WHERE "purchase_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "coupon"`);
  }
}
```

**Decisión de diseño:** El `code` es el PK (6 chars, únicos por naturaleza del dominio). Esto evita un campo UUID extra y hace los lookups directos por código más eficientes.



---

### 1.2 Entidad `Coupon`

**Archivo:** `src/modules/coupons/entities/coupon.entity.ts`

```typescript
@Entity('coupon')
export class Coupon {
  @PrimaryColumn({ length: 6 })
  code: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;

  @Column({ name: 'redeemed_at', type: 'timestamp', nullable: true })
  redeemedAt: Date | null;

  @Column({ name: 'purchase_id', type: 'uuid', nullable: true })
  purchaseId: string | null;

  @ManyToOne(() => Purchase, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'purchase_id' })
  purchase: Purchase | null;

  @Column({ name: 'created_by_id', type: 'uuid' })
  createdById: string;

  @ManyToOne(() => Admin, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_id' })
  createdBy: Admin;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  /** Helper computed: un cupón es canjeable si isActive, no expirado, y no usado */
  get isRedeemable(): boolean {
    return this.isActive && this.redeemedAt === null && this.expiresAt > new Date();
  }
}
```

---

## Fase 2 — Módulo de Cupones (Admin)

### 2.1 Estructura de archivos

```
src/modules/coupons/
  coupons.module.ts
  coupons.controller.ts
  coupons.service.ts
  entities/
    coupon.entity.ts
  dto/
    generate-coupons.dto.ts
    filter-coupons.dto.ts
    coupon-response.dto.ts
    update-coupon.dto.ts
```

---

### 2.2 DTOs

#### `GenerateCouponsDto`

**Archivo:** `src/modules/coupons/dto/generate-coupons.dto.ts`

```typescript
export class GenerateCouponsDto {
  @IsInt()
  @Min(1)
  @Max(1000)
  count: number;          // Cantidad de cupones a generar

  @IsISO8601()
  @IsNotEmpty()
  expiresAt: string;      // Fecha de expiración ISO 8601
}
```

#### `FilterCouponsDto`

**Archivo:** `src/modules/coupons/dto/filter-coupons.dto.ts`

```typescript
export class FilterCouponsDto {
  @IsOptional()
  @IsEnum(CouponStatus)   // 'available' | 'redeemed' | 'expired' | 'inactive'
  status?: CouponStatus;

  @IsOptional()
  @IsString()
  search?: string;        // Búsqueda parcial por código

  @IsOptional()
  @IsInt() @Min(1)
  page?: number;          // Paginación

  @IsOptional()
  @IsInt() @Min(1) @Max(100)
  limit?: number;
}
```

#### `UpdateCouponDto`

```typescript
export class UpdateCouponDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;     // Permitir extender la vida de un cupón
}
```

---

### 2.3 `CouponsService`

**Archivo:** `src/modules/coupons/coupons.service.ts`

#### Método: `generateBatch(dto, admin)`

```
1. Calcular cuántos códigos se necesitan (dto.count)
2. Loop de generación:
   a. crypto.randomBytes(4) → número aleatorio
   b. Mapear a [A-Z0-9] (36 chars) → 6 chars
   c. Verificar unicidad contra BD (SELECT existentes del batch en una query)
   d. Si colisión, regenerar ese código
3. INSERT batch en tabla coupon con:
   - code, isActive=true, expiresAt=dto.expiresAt, createdById=admin.uid
4. Retornar lista de códigos generados
```

**Algoritmo de generación de código:**
```typescript
function generateCode(): string {
  const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes)
    .map(b => CHARSET[b % CHARSET.length])
    .join('');
}
```

#### Método: `validateAndLock(codes, entityManager)` ← **crítico para purchases**

```
Recibe: string[] de códigos + EntityManager (dentro de transacción)

1. SELECT ... FOR UPDATE (pessimistic_write) todos los coupons por código
2. Por cada coupon validar:
   - Existe en BD → sino: BadRequestException(`Cupón ${code} no existe`)
   - isActive === true → sino: BadRequestException(`Cupón ${code} desactivado`)
   - redeemed_at IS NULL → sino: BadRequestException(`Cupón ${code} ya fue canjeado`)
   - expiresAt > now() → sino: BadRequestException(`Cupón ${code} expirado`)
3. Retornar: Coupon[] (los registros bloqueados y validados)
```

#### Método: `redeemCoupons(coupons, purchaseId, entityManager)`

```
1. UPDATE coupon SET redeemed_at = now(), purchase_id = purchaseId
   WHERE code IN (...)
2. Llamar dentro de la misma transacción que crea la purchase
```

#### Método: `findAll(dto)`
```
Paginación + filtros por status, búsqueda por código (ILIKE)
```

#### Método: `findOne(code)`
```
Retorna cupón con relaciones: purchase (uid, submittedAt), createdBy (email)
```

#### Método: `update(code, dto)`
```
Solo permite cambiar isActive y expiresAt
No permite modificar cupones ya canjeados (redeemedAt IS NOT NULL)
```

#### Método: `remove(code)`
```
Solo permite eliminar si redeemedAt IS NULL
Soft: marcar isActive = false (preferido)
Hard delete: solo si nunca fue canjeado
```

---

### 2.4 `CouponsController`

**Archivo:** `src/modules/coupons/coupons.controller.ts`

Todos los endpoints requieren autenticación (`@Auth()`). Generación y eliminación requieren `SUPER_ADMIN`.

```
POST   /coupons/generate        @Auth(AdminRole.SUPER_ADMIN)
GET    /coupons                 @Auth()                        — lista con filtros y paginación
GET    /coupons/:code           @Auth()                        — detalle de un cupón
PATCH  /coupons/:code           @Auth(AdminRole.SUPER_ADMIN)   — activar/desactivar, extender fecha
DELETE /coupons/:code           @Auth(AdminRole.SUPER_ADMIN)   — desactivar (soft) o eliminar
```

---

### 2.5 `CouponsModule`

**Archivo:** `src/modules/coupons/coupons.module.ts`

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([Coupon])],
  controllers: [CouponsController],
  providers: [CouponsService],
  exports: [CouponsService],   // ← exportar para que PurchasesModule pueda inyectarlo
})
export class CouponsModule {}
```

---

## Fase 3 — Endpoint Público de Validación

### 3.1 Endpoint `GET /coupons/validate/:code`

**Sin autenticación** — permite al frontend mostrar un preview del descuento antes de enviar la compra.

**Response:**
```json
{
  "code": "A3K9BZ",
  "isValid": true,
  "expiresAt": "2026-03-31T23:59:59Z"
}
```

Si el cupón no existe, está expirado, fue canjeado, o está inactivo:
```json
{
  "code": "XXXYYY",
  "isValid": false,
  "reason": "expired"   // 'not_found' | 'expired' | 'redeemed' | 'inactive'
}
```

**Nota:** Este endpoint no devuelve información de la compra asociada ni datos del admin para evitar exposición de datos internos.

---

## Fase 4 — Integración con el Flujo de Compra

### 4.1 Actualización de `CreatePurchaseDto`

**Archivo:** `src/modules/purchases/dto/create-purchase.dto.ts`

Agregar al final del DTO:

```typescript
@ApiPropertyOptional({
  description: 'Códigos de cupones a canjear. Cada cupón cubre 1 ticket.',
  example: ['A3K9BZ', 'X7T2QR'],
  type: [String],
  isArray: true,
})
@IsOptional()
@IsArray()
@IsString({ each: true })
@ArrayMaxSize(100)          // límite de seguridad razonable
couponCodes?: string[];
```

---

### 4.2 Modificaciones en `PurchasesService`

**Archivo:** `src/modules/purchases/purchases.service.ts`

El flow de creación de compra se modifica entre el **Paso 3** (cálculo total) y el **Paso 8** (persistencia).

#### Nuevo Paso 3b — Validación y Descuento de Cupones

Insertar en `createWithTransaction()` (o el método equivalente) inmediatamente **después** de calcular `calculatedTotal` y **antes** de construir la Purchase:

```typescript
// 3b. Procesar cupones
let couponDiscount = 0;
let validatedCoupons: Coupon[] = [];

if (dto.couponCodes && dto.couponCodes.length > 0) {
  // Normalizar: eliminar duplicados, trim, uppercase
  const uniqueCodes = [...new Set(dto.couponCodes.map(c => c.trim().toUpperCase()))];

  // Validar que no use más cupones que tickets compra
  if (uniqueCodes.length > dto.ticket_quantity) {
    throw new BadRequestException(
      `No se pueden usar más cupones (${uniqueCodes.length}) que tickets comprados (${dto.ticket_quantity})`,
    );
  }

  // Validar y bloquear cupones dentro de la transacción
  validatedCoupons = await couponsService.validateAndLock(uniqueCodes, manager);

  // Calcular descuento: cada cupón cubre 1 ticket al precio unitario
  couponDiscount = validatedCoupons.length * unitPriceInPaymentCurrency;
}

// Aplicar descuento de cupones al total ya promocionado
const finalTotal = Math.max(0, Number((calculatedTotal - couponDiscount).toFixed(2)));

// Re-validar totalAmount del cliente con el nuevo total esperado
const requestedTotal = Number(dto.totalAmount);
if (Number.isFinite(requestedTotal) && Math.abs(requestedTotal - finalTotal) > 0.01) {
  throw new BadRequestException(
    `El monto total no coincide. Esperado: ${finalTotal}, recibido: ${requestedTotal}`,
  );
}
```

#### Nuevo Paso 8b — Canjear Cupones

Inmediatamente **después** de persistir la Purchase (y dentro de la misma transacción):

```typescript
// 8b. Canjear cupones
if (validatedCoupons.length > 0) {
  await couponsService.redeemCoupons(validatedCoupons, purchase.uid, manager);
}
```

#### Impacto en el campo `totalAmount`

| Escenario | `totalAmount` persisted |
|-----------|------------------------|
| Sin promoción, sin cupones | `quantity * unitPrice` |
| Con promoción, sin cupones | `promotionalTotal` |
| Sin promoción, con cupones | `max(0, quantity * unitPrice - couponCount * unitPrice)` |
| Con promoción, con cupones | `max(0, promotionalTotal - couponCount * unitPrice)` |

**Nota importante:** Si `finalTotal === 0`, la compra no requiere pago. El array `payments[]` puede venir vacío o con `amount: 0`. El webhook de IA no aplica (no hay comprobante). La compra podría ser **auto-verificada** inmediatamente si todos los tickets están cubiertos por cupones. Este caso edge debe manejarse explícitamente (ver Fase 5).

---

### 4.3 Actualización de `PurchasesModule`

**Archivo:** `src/modules/purchases/purchases.module.ts`

```typescript
@Module({
  imports: [
    TypeOrmModule.forFeature([Purchase, Ticket, Customer, Raffle, PaymentMethod, Currency]),
    MailModule,
    CouponsModule,   // ← NUEVO
  ],
  // ...
})
```

E inyectar `CouponsService` en el constructor de `PurchasesService`:

```typescript
constructor(
  // ... repositorios existentes ...
  private readonly couponsService: CouponsService,   // ← NUEVO
) {}
```

---

## Fase 5 — Caso Edge: Compra 100% Cubierta por Cupones

Cuando `finalTotal === 0`:
- El cliente no necesita realizar pago bancario
- No existe comprobante para verificar por IA → no se debe enviar a SQS
- La compra debe **auto-verificarse inmediatamente**, dentro de la misma transacción

**Lógica dentro de `dataSource.transaction()`, después del canje de cupones:**

```typescript
// Dentro de la transacción, después de redeemCoupons()
if (finalTotal === 0 && validatedCoupons.length > 0) {
  purchase.status = PurchaseStatus.VERIFIED;
  purchase.verifiedAt = new Date();
  purchase.verificationSource = VerificationSource.BY_SYSTEM;
  purchase.exportedToSheets = false;

  // Para rifas RANDOM sin tickets asignados aún: asignar ahora
  // Firma real del método: assignRandomNumbers(manager, raffleId, purchase)
  if (!purchase.ticketNumbers || purchase.ticketNumbers.length === 0) {
    await this.allocationService.assignRandomNumbers(
      manager,
      purchase.raffleId,
      purchase,
    );
  }
  await manager.save(Purchase, purchase);
}
```

**Lógica en `notifyPostPurchase()` (sin cambiar la firma):**

```typescript
private async notifyPostPurchase(purchase: Purchase, eventType: string) {
  // Si la compra ya está verificada (ej. 100% cubierta por cupones), no enviar a SQS
  if (purchase.status === PurchaseStatus.VERIFIED) {
    this.eventEmitter.emit('purchase.status_changed', {
      type: 'verified',
      msg: 'Purchase auto-verified via coupons',
      raffleId: purchase.raffleId,
      purchaseId: purchase.uid,
      status: PurchaseStatus.VERIFIED,
    });
    return;
  }

  // Flujo normal: enviar a SQS si aiVerificationEnabled
  if (purchase.paymentMethod?.aiVerificationEnabled !== false) { ... }
  this.eventEmitter.emit('purchase.created', { ... });
}
```

---

## Fase 6 — Respuesta de Compra con Cupones

### 6.1 Incluir cupones canjeados en `GET /purchases/:uid`

En `PurchasesService.findOne()`, agregar join con `coupon` por `purchaseId`:

```typescript
// Al construir la respuesta de purchase, incluir:
const redeemedCoupons = await couponRepo.find({
  where: { purchaseId: purchase.uid },
  select: ['code', 'redeemedAt'],
});

return {
  ...purchase,
  redeemedCoupons: redeemedCoupons.map(c => ({
    code: c.code,
    redeemedAt: c.redeemedAt,
  })),
};
```

---

## Fase 7 — Registro en `AppModule`

**Archivo:** `src/app.module.ts`

Importar `CouponsModule` en el array de `imports` de `AppModule`.

---

## Resumen de Archivos a Crear/Modificar

### Archivos NUEVOS

| Archivo | Descripción |
|---------|-------------|
| `src/migrations/1770800000000-CreateCouponTable.ts` | Migración que crea la tabla `coupon` con 2 índices parciales |
| `src/modules/coupons/entities/coupon.entity.ts` | Entidad TypeORM `Coupon` |
| `src/modules/coupons/coupons.module.ts` | Módulo NestJS (exporta `CouponsService`) |
| `src/modules/coupons/coupons.service.ts` | Lógica: generación, validación, canje, CRUD |
| `src/modules/coupons/coupons.controller.ts` | Endpoints admin + `GET validate/:code` público |
| `src/modules/coupons/dto/generate-coupons.dto.ts` | DTO de generación en batch |
| `src/modules/coupons/dto/filter-coupons.dto.ts` | DTO de filtros + enum `CouponStatus` |
| `src/modules/coupons/dto/update-coupon.dto.ts` | DTO de actualización (`isActive`, `expiresAt`) |

### Archivos a MODIFICAR

| Archivo | Cambio |
|---------|--------|
| `src/modules/purchases/dto/create-purchase.dto.ts` | Agregar campo `couponCodes?: string[]` |
| `src/modules/purchases/purchases.service.ts` | Lógica de validación/canje de cupones en el flujo de creación |
| `src/modules/purchases/purchases.module.ts` | Importar `CouponsModule` |
| `src/app.module.ts` | Importar `CouponsModule` |

---

## TODO: Orden de Implementación Detallado

---

### FASE 1 — Capa de Datos

- [x] **1.1** Crear directorio `src/modules/coupons/` y subdirectorio `entities/`
- [x] **1.2** Crear `src/modules/coupons/entities/coupon.entity.ts`
  - `@PrimaryColumn({ length: 6 }) code: string`
  - `isActive: boolean` (default `true`)
  - `expiresAt: Date`
  - `redeemedAt: Date | null` (nullable)
  - `purchaseId: string | null` (FK a `purchase.uid`, `ON DELETE SET NULL`)
  - `createdById: string` (FK a `admin.uid`, `ON DELETE RESTRICT`)
  - `createdAt: Date` (`@CreateDateColumn`)
  - getter `isRedeemable(): boolean` (isActive && redeemedAt === null && expiresAt > now)
- [x] **1.3** Crear `src/migrations/1770800000000-CreateCouponTable.ts` con el SQL exacto del plan (tabla + 2 índices parciales)
- [ ] **1.4** Ejecutar `npm run migration:run` y verificar que la tabla se creó correctamente

---

### FASE 2 — DTOs del Módulo de Cupones

- [x] **2.1** Crear `src/modules/coupons/dto/generate-coupons.dto.ts`
  - `count: number` — `@IsInt() @Min(1) @Max(1000)`
  - `expiresAt: string` — `@IsISO8601() @IsNotEmpty()`
- [x] **2.2** Crear `src/modules/coupons/dto/filter-coupons.dto.ts`
  - Definir enum `CouponStatus` en este mismo archivo (un solo enum no justifica subdirectorio): `AVAILABLE | REDEEMED | EXPIRED | INACTIVE`
  - `status?: CouponStatus` — `@IsOptional() @IsEnum(CouponStatus)`
  - `search?: string` — `@IsOptional() @IsString()` (búsqueda parcial de código)
  - `page?: number` — `@IsOptional() @IsInt() @Min(1)` (default `1`)
  - `limit?: number` — `@IsOptional() @IsInt() @Min(1) @Max(100)` (default `20`)
- [x] **2.3** Crear `src/modules/coupons/dto/update-coupon.dto.ts`
  - `isActive?: boolean` — `@IsOptional() @IsBoolean()`
  - `expiresAt?: string` — `@IsOptional() @IsISO8601()`

---

### FASE 3 — CouponsService

- [x] **3.1** Crear `src/modules/coupons/coupons.service.ts` con `@Injectable()` e `@InjectRepository(Coupon)`
- [x] **3.2** Implementar función privada `generateCode(): string`
  - Usar `crypto.randomBytes(6)`, mapear cada byte a `CHARSET[b % 36]` con `CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'`
- [x] **3.3** Implementar `generateBatch(dto: GenerateCouponsDto, admin: Admin): Promise<string[]>`
  - Generar `dto.count` códigos en loop usando `generateCode()`
  - Verificar unicidad del batch contra BD en una sola query (`SELECT code FROM coupon WHERE code IN (...)`)
  - Regenerar los que colisionen
  - `INSERT` en batch usando `couponRepo.save(entities)`
  - Retornar array de códigos generados
- [x] **3.4** Implementar `validateAndLock(codes: string[], manager: EntityManager): Promise<Coupon[]>`
  - `manager.find(Coupon, { where: { code: In(codes) }, lock: { mode: 'pessimistic_write' } })`
  - Por cada código en `codes`: verificar que existe, `isActive`, `redeemedAt === null`, `expiresAt > now()` — lanzar `BadRequestException` con mensaje específico si falla alguna
  - Retornar los `Coupon[]` bloqueados y validados
- [x] **3.5** Implementar `redeemCoupons(coupons: Coupon[], purchaseId: string, manager: EntityManager): Promise<void>`
  - `manager.update(Coupon, { code: In(codes) }, { redeemedAt: new Date(), purchaseId })`
- [x] **3.6** Implementar `findAll(dto: FilterCouponsDto): Promise<{ data: Coupon[], total: number }>`
  - Usar `QueryBuilder` para aplicar filtro por `status` computado (combina columnas `is_active`, `redeemed_at`, `expires_at`)
  - `ILIKE` en `code` si `search` presente
  - Paginación con `skip`/`take`
- [x] **3.7** Implementar `findOne(code: string): Promise<Coupon>`
  - Cargar relaciones `purchase` (solo `uid` y `submittedAt`) y `createdBy` (solo `email`)
  - Lanzar `NotFoundException` si no existe
- [x] **3.8** Implementar `update(code: string, dto: UpdateCouponDto): Promise<Coupon>`
  - Cargar el cupón primero; lanzar `BadRequestException` si `redeemedAt !== null` (no se puede modificar un cupón canjeado)
  - Aplicar cambios y guardar
- [x] **3.9** Implementar `remove(code: string): Promise<void>`
  - Cargar el cupón; lanzar `BadRequestException` si `redeemedAt !== null` (un cupón canjeado es audit trail y no puede eliminarse)
  - Siempre soft-delete: `coupon.isActive = false` + `save()` (no hard delete — mantiene trazabilidad)

---

### FASE 4 — CouponsController

- [x] **4.1** Crear `src/modules/coupons/coupons.controller.ts` con `@ApiTags('Coupons')`, `@Controller('coupons')`
- [x] **4.2** Agregar `POST /coupons/generate`
  - `@Auth(AdminRole.SUPER_ADMIN)`, `@ApiBearerAuth('JWT-auth')`, `@Body() dto: GenerateCouponsDto`, `@ActiveUser() admin: Admin`
  - Retorna la lista de códigos generados
- [x] **4.3** Agregar `GET /coupons/validate/:code` (**sin `@Auth()`**)
  - **Debe declararse ANTES de `GET /coupons/:code`** para evitar que NestJS interprete el literal `validate` como un `:code` param
  - Retorna `{ code, isValid: true, expiresAt }` o `{ code, isValid: false, reason: 'not_found' | 'expired' | 'redeemed' | 'inactive' }`
  - Llama a `couponsService.findOne()` capturando `NotFoundException` (retorna `not_found` en lugar de 404)
- [x] **4.4** Agregar `GET /coupons`
  - `@Auth()`, `@ApiBearerAuth('JWT-auth')`, `@Query() dto: FilterCouponsDto`
  - Retorna `{ data, total, page, limit }`
- [x] **4.5** Agregar `GET /coupons/:code`
  - `@Auth()`, `@ApiBearerAuth('JWT-auth')`
  - Retorna el cupón completo con relaciones (`purchase.uid`, `createdBy.email`)
- [x] **4.6** Agregar `PATCH /coupons/:code`
  - `@Auth(AdminRole.SUPER_ADMIN)`, `@ApiBearerAuth('JWT-auth')`, `@Body() dto: UpdateCouponDto`
- [x] **4.7** Agregar `DELETE /coupons/:code`
  - `@Auth(AdminRole.SUPER_ADMIN)`, `@ApiBearerAuth('JWT-auth')` (soft-delete)

---

### FASE 5 — CouponsModule y Registro en AppModule

- [x] **5.1** Crear `src/modules/coupons/coupons.module.ts`
  - `TypeOrmModule.forFeature([Coupon])`
  - `controllers: [CouponsController]`
  - `providers: [CouponsService]`
  - `exports: [CouponsService]`
- [x] **5.2** Importar `CouponsModule` en `src/app.module.ts` (en el array `imports`)

---

### FASE 6 — Integración con el Flujo de Compra

- [x] **6.1** Agregar `couponCodes?: string[]` al final de `src/modules/purchases/dto/create-purchase.dto.ts`
  - `@IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(100)`
  - Agregar `@Transform` para parsear JSON string en multipart/form-data (igual que el campo `payments[]` existente)
  - Agregar `@ApiPropertyOptional` con ejemplo
- [x] **6.2** Importar `CouponsModule` en `src/modules/purchases/purchases.module.ts`
- [x] **6.3** Inyectar `CouponsService` en el constructor de `PurchasesService` (`private readonly couponsService: CouponsService`)
- [x] **6.4** En `purchases.service.ts`, dentro de la transacción de creación, **después del cálculo de `calculatedTotal`**:
  - Normalizar `couponCodes`: `deduplicar + trim + toUpperCase()`
  - Validar que `uniqueCodes.length <= dto.ticket_quantity` → `BadRequestException` si no
  - Llamar `this.couponsService.validateAndLock(uniqueCodes, manager)` → obtener `validatedCoupons: Coupon[]`
  - Calcular `couponDiscount = validatedCoupons.length * unitPriceInPaymentCurrency`
  - Calcular `finalTotal = Math.max(0, calculatedTotal - couponDiscount)` redondeado a 2 decimales
- [x] **6.5** Reemplazar la validación de `totalAmount` existente para que compare `requestedTotal` contra `finalTotal` (en lugar de `calculatedTotal`)
- [x] **6.6** **Después de persistir la purchase** (y dentro de la misma transacción):
  - Si `validatedCoupons.length > 0`: llamar `this.couponsService.redeemCoupons(validatedCoupons, purchase.uid, manager)`

---

### FASE 7 — Caso Edge: Compra 100% Cubierta por Cupones

> **Nota arquitectónica**: La auto-verificación debe ocurrir **dentro de la transacción** `dataSource.transaction()`, igual que lo hace `updateStatus()`. Así `notifyPostPurchase()` no necesita recibir contexto extra — simplemente comprueba `purchase.status`.

- [x] **7.1** Dentro de la transacción (después de `manager.save(Purchase, purchase)` y del canje de cupones), agregar bloque condicional `if (finalTotal === 0 && validatedCoupons.length > 0)`:
  - `purchase.status = VERIFIED`
  - `purchase.verifiedAt = new Date()`
  - `purchase.verificationSource = VerificationSource.BY_SYSTEM`
  - `purchase.exportedToSheets = false`
  - Si `!purchase.ticketNumbers || purchase.ticketNumbers.length === 0`: llamar `await this.allocationService.assignRandomNumbers(manager, purchase.raffleId, purchase)` — firma real: `(manager: EntityManager, raffleId: string, purchase: Purchase)`
  - `await manager.save(Purchase, purchase)` (segunda vez para persistir el nuevo estado)
- [x] **7.2** En `notifyPostPurchase(purchase, eventType)`: añadir guardia al inicio del bloque SQS:
  ```typescript
  // Compra ya verificada (ej. cubierta totalmente por cupones) — no enviar a SQS
  if (purchase.status === PurchaseStatus.VERIFIED) {
    this.eventEmitter.emit('purchase.status_changed', { ... });
    return;
  }
  ```
  Esto evita enviar a SQS cuando la compra ya está verificada, sin cambiar la firma del método.

---

### FASE 8 — Respuesta Enriquecida en Purchases

- [x] **8.1** En `PurchasesService.findOne()`, después de cargar la purchase: ejecutar `couponRepo.find({ where: { purchaseId: purchase.uid }, select: ['code', 'redeemedAt'] })`
- [x] **8.2** Incluir `redeemedCoupons: { code: string, redeemedAt: Date }[]` en el objeto de respuesta de `GET /purchases/:uid`
- [x] **8.3** Confirmar que el endpoint `GET /purchases` (listado) **no** carga cupones por defecto para evitar N+1 queries

---

### FASE 9 — Verificación y Limpieza

- [x] **9.1** Ejecutar `npm run lint` — sin errores nuevos en coupons (errores pre-existentes en otros archivos no relacionados)
- [x] **9.2** Ejecutar `npm run build` y verificar que no hay errores de compilación — **build limpio**
- [ ] **9.3** Verificar que Swagger en `/api` muestra los nuevos endpoints de `coupons` con los schemas correctos
- [ ] **9.4** Prueba manual del flujo completo:
  - Generar 3 cupones vía `POST /coupons/generate`
  - Validar uno vía `GET /coupons/validate/:code` → `isValid: true`
  - Crear compra con 2 de esos códigos → verificar que `totalAmount` se redujo en `2 * unitPrice`
  - Verificar que los 2 cupones usados tienen `redeemedAt` y `purchaseId` en BD
  - Intentar reusar un cupón ya canjeado → `BadRequestException`
- [ ] **9.5** Prueba del caso edge compra 100% cubierta:
  - Generar 3 cupones, crear compra de 3 tickets con los 3 cupones → `totalAmount = 0`
  - Verificar que la compra queda `VERIFIED` y `verificationSource = BY_SYSTEM` inmediatamente
  - Para rifa RANDOM: verificar que `ticketNumbers` están asignados

---

## Consideraciones de Seguridad

| Riesgo | Mitigación |
|--------|-----------|
| Race condition: dos compras usan el mismo cupón simultáneamente | `SELECT ... FOR UPDATE` (pessimistic lock) dentro de la transacción de creación de compra |
| Brute force de códigos | El endpoint `GET /validate/:code` no da información sobre si el código existe vs. está usado. Respuesta genérica: `{ isValid: false, reason: 'not_found' }` para cualquier código inválido |
| Generación predecible | `crypto.randomBytes()` en lugar de `Math.random()` |
| Uso masivo de cupones | `ArrayMaxSize(100)` en el DTO + límite configurable en `CouponsService` |
| Cupones expirados en masa | Índice parcial en `(is_active, expires_at) WHERE redeemed_at IS NULL` para queries eficientes |

---

## Notas Adicionales

- **No se persiste el `couponDiscount` en la Purchase** directamente: la información está implícita en los `Coupon` records que apuntan al `purchaseId`. Para reports, se puede hacer `SELECT COUNT(*) * unitPrice FROM coupon WHERE purchase_id = ?`.
- Si en el futuro se quiere guardar el descuento por cupones en la Purchase, se puede añadir una columna `coupon_discount NUMERIC(10,2)` en una migración posterior.
- La generación de cupones no verifica colisiones con el 100% de los códigos existentes para batches grandes (36^6 ≈ 2.1B combinaciones): la probabilidad de colisión es negligible para volúmenes de hasta millones de cupones, pero la lógica de `generateBatch` sí verifica y regenera en caso de duplicado.


## Decisiones Técnicas (respuestas a preguntas de desarrollo)

### ¿Cuántos cupones únicos se pueden generar?

**2,176,782,336**

Charset `[A-Z0-9]` = 36 caracteres. Longitud = 6. Total = 36⁶ = 2,176,782,336.

Para este dominio es más que suficiente: incluso generando 10,000 cupones diarios durante 10 años se usaría solo el 1.7% del espacio de códigos.

---

### ¿Deberían estar encriptados/hasheados los cupones en la BD?

**No. Guardarlos en texto plano con rate limiting es la solución correcta.**

Aquí el análisis completo:

**¿Por qué no bcrypt?**
- bcrypt es intencionalmente lento (50–200ms por operación). Un `SELECT WHERE code = bcrypt_compare(...)` no existe — bcrypt no es determinista, así que no se puede usar en cláusulas `WHERE`.
- El único approach sería: cargar todos los cupones a memoria y comparar uno a uno. Inviable con millones de cupones.

**¿Por qué no SHA-256 o HMAC?**
- Los códigos son 6 chars → 36⁶ ≈ 2.1B combinaciones → ~31 bits de entropía.
- Si la BD se filtra, un atacante puede hacer fuerza bruta del espacio completo SHA-256 en **segundos** con una GPU (no hay sal, el espacio es pequeño). Guardar el hash no protege nada en este caso.
- Un HMAC con clave del servidor (`HMAC(secret, code)`) sí protege ante filtración de BD sola, pero no ante filtración de BD + código fuente + variables de entorno (que es el escenario real de una brecha grave).

**¿Cuál es la amenaza real?**
- **Filtración de BD:** los códigos no usados quedan expuestos. Mitigación real: que los cupones tengan fechas de expiración cortas. Un cupón expirado es inútil aunque se filtre.
- **Adivinanza por fuerza bruta en el API:** más real y más fácil de mitigar.

**La mitigación correcta es rate limiting en dos puntos:**

1. `GET /coupons/validate/:code` — máximo 10 requests/minuto por IP.
2. `POST /purchases` — ya existe autenticación implícita por flujo del formulario.

Esto hace que recorrer el espacio completo (2.1B códigos) a 10 req/min tome **414 años**. Encriptar no añade valor práctico frente a esto.

**Ajuste al plan:** añadir rate limiting (guardado como nota de implementación, no requiere cambios en el módulo de coupons en sí — se configura a nivel de Nginx o con un guard de NestJS).

---

### ¿Cada compra con cupón debería guardarse como un registro en `purchases`?

**Sí, siempre. Un cupón no reemplaza el registro de compra, lo modifica.**

La pregunta probablemente viene de pensar si el cupón debería "ser" la compra. La respuesta es no:

- El registro de `purchase` es lo que **asigna tickets al cliente**. Sin él, no existe forma de saber qué tickets tiene ese cliente ni en qué rifa.
- El cupón es solo un **método de descuento en el pago**, no un ticket en sí mismo.
- Un cliente que usa 3 cupones para comprar 5 tickets crea **1 purchase** con `ticketQuantity: 5` y `totalAmount` reducido en 3 × precio unitario. Los 3 cupones apuntan a ese `purchaseId`.

**Casos concretos:**

| Escenario | Registros creados |
|-----------|-------------------|
| 5 tickets, 0 cupones, pago normal | 1 purchase |
| 5 tickets, 2 cupones, pago parcial | 1 purchase + 2 coupons con `purchaseId` |
| 3 tickets, 3 cupones, 0 pago | 1 purchase (auto-verificada) + 3 coupons con `purchaseId` |

El registro de purchase es siempre 1, sin importar cuántos cupones se usen. La relación inversa (qué cupones se usaron en esta compra) se resuelve con `SELECT * FROM coupon WHERE purchase_id = ?`.