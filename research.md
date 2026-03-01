# Research: Módulo de Purchases — Documentación Completa

## Objetivo

Documentar en profundidad cómo funciona el módulo de `purchases` (compras), incluyendo el sistema de promociones, flujo de creación, asignación de tickets, webhooks de IA, y reconciliación bancaria. Esta base sirve para diseñar el feature de cupones.

---

## 1. Modelo de Datos

### 1.1 Entidad `Purchase`

**Archivo:** `src/modules/purchases/entities/purchase.entity.ts`

| Campo                  | Tipo              | Nullable | Descripción                                                            |
|------------------------|-------------------|----------|------------------------------------------------------------------------|
| `uid`                  | UUID              | No       | PK, auto-generado                                                      |
| `raffleId`             | string            | No       | FK a `Raffle`                                                          |
| `customerId`           | string            | No       | FK a `Customer`                                                        |
| `paymentMethodId`      | string            | No       | FK a `PaymentMethod`                                                   |
| `ticketQuantity`       | integer           | No       | Cantidad de tickets comprados                                          |
| `paymentScreenshotUrl` | string            | Sí       | **DEPRECATED** — usar `payments[].evidenceUrl`                         |
| `bankReference`        | string            | Sí       | **DEPRECATED** — usar `payments[].reference`                           |
| `notes`                | text              | Sí       | Notas de auditoría / rechazo                                           |
| `status`               | enum              | No       | `PENDING \| VERIFIED \| REJECTED \| MANUAL_REVIEW \| DUPLICATED`       |
| `totalAmount`          | numeric(10,2)     | Sí       | Total en moneda de pago (ya con descuento de promoción si aplica)      |
| `totalPaid`            | numeric(10,2)     | No       | Suma de `payments[].amount` (pagos verificados por IA)                 |
| `promotionSnapshot`    | JSONB             | Sí       | `{ strategy, config, originalAmount, discountAmount }` — congelado al momento de compra |
| `aiAnalysisResult`     | JSONB             | Sí       | Resultado crudo del OCR Lambda                                         |
| `submittedAt`          | timestamp         | No       | Auto-set en creación (`@CreateDateColumn`)                             |
| `verifiedAt`           | timestamp         | Sí       | Cuándo fue verificada la compra                                        |
| `verificationSource`   | enum              | Sí       | `AI \| ADMIN \| BY_SYSTEM`                                              |
| `verifiedByAdmin`      | Admin             | Sí       | FK al Admin que verificó manualmente                                   |
| `auditReviewedAt`      | timestamp         | Sí       | Cuándo un humano revisó una compra verificada por IA (doble chequeo)   |
| `ticketNumbers`        | integer[]         | Sí       | Números asignados; null en rifas RANDOM hasta verificación             |
| `exportedToSheets`     | boolean           | No       | Flag para el cron de Google Sheets (reset a false al cambiar estado)   |
| `payments`             | JSONB             | No       | Array de `PaymentEntry[]` — multi-pago (más reciente)                  |

#### Interface `PaymentEntry` (dentro del JSONB `payments`)

```typescript
interface PaymentEntry {
  amount: number;
  reference: string;
  currency: string;
  evidenceUrl: string;
  verified: boolean;          // true cuando el AI validó este abono
  aiResult?: any;             // resultado OCR de este abono específico
  reviewedBy?: string;        // admin que lo revisó
  paymentMethodId?: string;   // override del método de pago para este abono
  paymentMethodName?: string; // nombre display del método de pago
}
```

#### Interface `PromotionSnapshot` (dentro del JSONB `promotionSnapshot`)

```typescript
interface PromotionSnapshot {
  strategy: string;          // 'nxm' | 'percentage'
  config: object;            // snapshot exacto del config al momento de compra
  originalAmount: number;    // precio sin descuento
  discountAmount: number;    // monto ahorrado
}
```

---

### 1.2 Entidad `Raffle` (campos relevantes para purchases)

| Campo                | Tipo    | Descripción                                             |
|----------------------|---------|---------------------------------------------------------|
| `status`             | enum    | `DRAFT \| ACTIVE \| CLOSED \| RESTRICTED`               |
| `selectionType`      | enum    | `RANDOM \| SPECIFIC`                                    |
| `ticketPrice`        | decimal | Precio base por ticket (en moneda de la rifa)           |
| `totalTickets`       | integer | Capacidad total de la rifa                              |
| `minTicketsPerPurchase` | integer | Mínimo de tickets por compra                         |
| `spreadsheetId`      | string  | ID del Google Sheet de la rifa (por rifa)               |
| `promotionStrategy`  | string  | `'nxm' \| 'percentage' \| null`                         |
| `promotionConfig`    | JSONB   | Configuración de la estrategia de promoción             |

---

### 1.3 Entidad `PaymentMethod` (campos relevantes)

| Campo                  | Tipo    | Descripción                                              |
|------------------------|---------|----------------------------------------------------------|
| `uid`                  | UUID    | PK                                                       |
| `name`                 | string  | Nombre único del método                                  |
| `sheetName`            | string  | Nombre estable para el tab de Google Sheets (≤31 chars)  |
| `currency`             | Currency | Relación eager con la moneda asociada                   |
| `aiVerificationEnabled` | boolean | Si false, NO se envía a SQS para OCR                   |
| `isActive`             | boolean | Si está activo para nuevas compras                       |
| `minimumPaymentAmount` | decimal | Monto mínimo de pago                                     |

La tasa de cambio está en `currency.value`. El precio en moneda de pago se calcula como:
```
unitPriceInPaymentCurrency = raffle.ticketPrice * currency.value
```

---

## 2. Sistema de Promociones

### 2.1 Promociones en la Rifa

Las promociones se configuran a nivel de rifa. La migración `1769600000000-AddPromotionToRaffle.ts` añadió dos columnas a la tabla `raffle`.

**Archivo:** `src/modules/raffles/utils/pricing.util.ts`

```typescript
export enum PromotionStrategy {
  NXM = 'nxm',             // Compra N, paga M
  PERCENTAGE = 'percentage', // Descuento porcentual
}
```

### 2.2 Estrategia NxM (`nxm`)

**Algoritmo greedy:**
1. Extraer reglas del config (soporta `{buy, pay}`, `{groups: [...]}`, `{rules: [...]}`)
2. Ordenar por `buy` descendente
3. Por cada regla: `packages = floor(remaining / buy)`, `ticketsToPay += packages * pay`
4. Resto se cobra a precio completo
5. `total = ticketsToPay * basePrice`

**Ejemplo:** regla `buy:5, pay:4`, precio $10, 12 tickets → 2 paquetes de 5 (paga 8) + 2 restantes = 10 tickets × $10 = **$100** (ahorra $20)

### 2.3 Estrategia Porcentaje (`percentage`)

Config: `{ percentage: number, minTickets?: number }` (también acepta `discount` como alias).

```
total = quantity * basePrice * (1 - percentage / 100)
```
Si `minTickets` definido y `quantity < minTickets` → sin descuento.

### 2.4 PromotionSnapshot en Purchase

Al crear una compra, si hay descuento (`discountAmount > 0.01`), se guarda un snapshot:
```typescript
promotionSnapshot = {
  strategy: raffle.promotionStrategy,
  config: raffle.promotionConfig,
  originalAmount: quantity * unitPriceInPaymentCurrency,
  discountAmount: originalAmount - calculatedTotal,
}
```

---

## 3. Flujo Completo de Creación de Compra

**Endpoint:** `POST /api/v1/purchases` (público, multipart/form-data)

**Archivo:** `src/modules/purchases/purchases.service.ts`

### Paso 1 — Lock de Rifa
```typescript
// Pessimistic write lock en la rifa para evitar sobreventa
raffle = entityManager.findOne(Raffle, { where: { uid }, lock: { mode: 'pessimistic_write' } })
// Valida que la rifa esté ACTIVE
```

### Paso 2 — Resolución del Método de Pago
```typescript
paymentMethod = repo.findOne(PaymentMethod, { where: { uid }, relations: ['currency'] })
currency = paymentMethod.currency
unitPriceInPaymentCurrency = raffle.ticketPrice * Number(currency.value)
```

### Paso 3 — Cálculo del Total y Promoción
```typescript
calculatedTotal = calculatePromotionalTotal(unitPrice, quantity, raffle.promotionStrategy, raffle.promotionConfig)
// Valida que el totalAmount enviado por el cliente coincida con ±0.01
if (|requestedTotal - calculatedTotal| > 0.01) → BadRequestException
// Genera promotionSnapshot si discountAmount > 0.01
```

### Paso 4 — Estrategia de Asignación de Tickets
```typescript
ticketNumbers = allocationService.determineAllocationStrategy(raffle, dto)
// SPECIFIC: valida ticket_numbers, verifica disponibilidad, retorna los números
// RANDOM:   valida que haya capacidad, retorna null (asigna post-verificación)
```

### Paso 5 — Obtener/Crear Cliente
```typescript
customer = customersService.findOrCreate(dto.customer)
// Verifica lista negra → ForbiddenException si está en blacklist
```

### Paso 6 — Subida de Evidencia
```typescript
// Si viene archivo adjunto: S3Service.uploadBuffer() → guarda S3 key
```

### Paso 7 — Construcción del Array de Pagos
```typescript
// Ruta nueva (payments[] provisto):
payments = dto.payments.map(p => ({ ...p, verified: false }))
totalPaid = sum(payments.map(p => p.amount))

// Ruta legacy (bank_reference + screenshot):
payments = [{ amount: dto.totalAmount, reference: dto.bank_reference, evidenceUrl: s3Key, verified: false }]
```

### Paso 8 — Persistencia
```typescript
purchase = purchaseRepo.create({
  raffleId, customerId, paymentMethodId,
  ticketQuantity: dto.ticket_quantity,
  ticketNumbers,           // null para RANDOM
  status: PENDING,
  totalAmount: calculatedTotal,
  totalPaid,
  payments,
  promotionSnapshot,       // null si no hubo descuento
})
await purchaseRepo.save(purchase)
```

### Paso 9 — Post-proceso (no bloqueante)
```typescript
notifyPostPurchase(purchase, paymentMethod):
  → SqsService.sendPurchaseCreatedMessage() [si aiVerificationEnabled !== false]
  → eventEmitter.emit('purchase.created', { type: 'created', purchaseId, raffleId })
```

---

## 4. Asignación de Tickets (`TicketAllocationService`)

**Archivo:** `src/modules/purchases/services/ticket-allocation.service.ts`

### 4.1 Tipo SPECIFIC

1. Valida que `ticket_numbers` esté presente y tenga la misma longitud que `ticket_quantity`
2. Sin duplicados internos (in-memory Set)
3. Rango válido: `0 <= num < raffle.totalTickets`
4. **Disponibilidad:** query SQL cuenta tickets ocupados en status `PENDING | VERIFIED | MANUAL_REVIEW`
   - Usa `unnest(ticket_numbers)` para trabajar con el array PostgreSQL
   - `ConflictException` si algún número está ocupado
5. Retorna `number[]` inmediatamente

### 4.2 Tipo RANDOM — Validación (en creación)

1. Cuenta tickets totales ocupados (`SUM(ticket_quantity)` en `PENDING | VERIFIED | MANUAL_REVIEW`)
2. Verifica `available = raffle.totalTickets - occupied >= requested_quantity`
3. Retorna `null` (asignación diferida)

### 4.3 Tipo RANDOM — Asignación (post-verificación)

Llamado por `PurchasesService` cuando la compra pasa a `VERIFIED`.

1. **Lock de Rifa** con `pessimistic_write`
2. Carga todos los `ticketNumbers` ocupados en `PENDING | VERIFIED | MANUAL_REVIEW | DUPLICATED`
3. Genera números aleatorios en loop:
   - `num = Math.floor(Math.random() * raffle.totalTickets)`
   - Descarta si ya está en `soldSet` o en el batch actual
   - Máximo intentos: `quantity * 10` → `ConflictException` si se agota
4. Guarda los nuevos `ticketNumbers` en la Purchase

---

## 5. Webhook de IA (`PurchaseVerificationService`)

**Endpoint:** `POST /api/v1/purchases/webhooks/ai-result`
**Auth:** Header `x-internal-secret` validado contra env var `AI_WEBHOOK_SIGNATURE`

**Archivo:** `src/modules/purchases/services/purchase-verification.service.ts`

### 5.1 Flujo principal

```
processAiWebhook(purchaseId, aiResult)
  → Pessimistic write lock en Purchase
  → Si ya está VERIFIED (llegó tarde) → retorna sin cambios
  → Guarda aiAnalysisResult en la purchase
  → Fase de detección de fraude
  → Fase de validación de datos
  → Fase de detección de duplicados
  → Fase de linkeo de pago
  → Fase de validación de monto
  → Fase de aprobación
```

### 5.2 Detección de Fraude
- `aiResult.isValidReceipt === false` → `MANUAL_REVIEW` con nota de motivo

### 5.3 Validación de Datos
- Extrae `amount` y `reference` del resultado OCR
- Cualquiera ausente → `MANUAL_REVIEW`

### 5.4 Detección de Duplicados
- Normaliza referencia: NFKC + mayúsculas + elimina no-alfanumérico
- Busca en BD: `bank_reference`, `ai_analysis_result.data.reference`, `payments[].reference`
- Si encuentra: `DUPLICATED`, limpia `ticketNumbers`

### 5.5 Linkeo de Pago
- Si tiene `payments[]`: busca la entrada que coincide por referencia
  - Prioridad `endsWith`, luego `contains` (mínimo 4 chars)
- Fallback a `bankReference` legacy
- Sin match → `MANUAL_REVIEW`

### 5.6 Validación de Monto
- Tolerancia ±1.00 (margen para varianza decimal en tipos de cambio)
- Compara contra `payment.amount` (multi-pago) o `totalAmount` (legacy)
- No coincide → `MANUAL_REVIEW`

### 5.7 Aprobación
- Marca `payment.verified = true`, guarda `aiResult` en el entry
- Recalcula `totalPaid = sum(verified payments)`
- Si `totalPaid >= totalAmount`:
  - `status = VERIFIED`, `verifiedAt = now()`, `verificationSource = AI`
  - `exportedToSheets = false` (encolar re-exportación)
  - Emite `purchase.status_changed`
  - Para rifas RANDOM: llama `assignRandomNumbers()`
- Si no: permanece `PENDING` (pago parcial verificado)

---

## 6. Reconciliación Bancaria (`ReconciliationService`)

**Endpoint:** `POST /api/v1/purchases/reconcile`
**Auth:** Roles `VERIFIER | VERIFIER_EXPORT | SUPER_ADMIN`

**Archivo:** `src/modules/purchases/services/reconciliation.service.ts`

1. `BankStatementParserService.parseStatement()` — parsea CSV/Excel a `BankTransaction[]`
2. Carga compras de la BD por `raffleId` + `paymentMethodId`
3. **Matching** por `amount` (±0.01) + `reference` normalizada (endsWith → contains ≥4 chars)
4. Fuente de referencia en compra: `aiAnalysisResult.data.reference` → `payments[].reference` → `bankReference`
5. Compras con match → `VERIFIED` con `verificationSource = BY_SYSTEM` (pessimistic write lock)
6. Retorna `ReconciliationResult` con matched/unmatchedBank/unmatchedDb

---

## 7. Eventos Emitidos

| Evento                    | Cuándo                                               | Payload clave                          |
|---------------------------|------------------------------------------------------|----------------------------------------|
| `purchase.created`        | Tras persistir la compra exitosamente                | `{ purchaseId, raffleId, type: 'created' }` |
| `purchase.status_changed` | Al cambiar estado manualmente o por IA/reconciliación| `{ purchaseId, raffleId, status }`    |

**Consumidores:**
- `PurchasesMailListener` — escucha ambos eventos; envía emails solo si `raffle.status === ACTIVE` (SES no configurado: emails se descartan silenciosamente)
- SSE stream en `GET /purchases/sse/stream` — notifica frontend en tiempo real

---

## 8. Endpoints del Controlador

**Prefijo:** `/api/v1/purchases`

| Método | Path                    | Roles                                      | Descripción                                       |
|--------|-------------------------|--------------------------------------------|---------------------------------------------------|
| POST   | `/`                     | Público                                    | Crear compra (multipart/form-data + archivo)      |
| GET    | `/`                     | VERIFIER, VERIFIER_EXPORT, SUPER_ADMIN     | Listar compras con filtros                        |
| POST   | `/upload-evidence`      | SUPER_ADMIN                                | Subir captura de pago a S3                        |
| POST   | `/export`               | VERIFIER_EXPORT, SUPER_ADMIN               | Exportar compras a Excel                          |
| POST   | `/export/receipts-pdf`  | SUPER_ADMIN                                | Exportar imágenes de comprobantes a PDF           |
| POST   | `/sheets/rebuild`       | SUPER_ADMIN                                | Reconstruir Google Sheets desde BD               |
| GET    | `/summary/by-raffle`    | VERIFIER, VERIFIER_EXPORT, SUPER_ADMIN     | Resumen de compras por rifa                       |
| GET    | `/sse/stream`           | Público                                    | Server-Sent Events para actualizaciones           |
| GET    | `/:uid`                 | Público                                    | Obtener compra por UID                            |
| PATCH  | `/:uid`                 | VERIFIER, VERIFIER_EXPORT, SUPER_ADMIN     | Actualizar compra                                 |
| PATCH  | `/:uid/status`          | VERIFIER, VERIFIER_EXPORT, SUPER_ADMIN     | Cambiar estado de compra                          |
| PATCH  | `/:uid/audit`           | VERIFIER, VERIFIER_EXPORT, SUPER_ADMIN     | Marcar como auditada (double-check)               |
| DELETE | `/:uid`                 | SUPER_ADMIN                                | Eliminar compra                                   |
| POST   | `/webhooks/ai-result`   | Público (firma en header)                  | Recibir resultado OCR del Lambda                  |
| POST   | `/webhooks/audit`       | Público (firma en header)                  | Webhook legacy de auditoría                       |
| POST   | `/reconcile`            | VERIFIER, VERIFIER_EXPORT, SUPER_ADMIN     | Reconciliación con estado bancario (archivo)      |

---

## 9. Estructura del Módulo

**Archivo:** `src/modules/purchases/purchases.module.ts`

### Entidades TypeORM registradas
`Purchase`, `Ticket`, `Customer`, `Raffle`, `PaymentMethod`, `Currency`

### Providers
| Servicio                      | Propósito                                      |
|-------------------------------|------------------------------------------------|
| `PurchasesService`            | Lógica de negocio principal                    |
| `PurchasesExportService`      | Exportación a Excel/PDF                        |
| `PurchaseVerificationService` | Lógica de verificación vía IA                  |
| `GoogleSheetsService`         | Sincronización a Google Sheets                 |
| `PurchasesCron`               | Cron hourly de exportación a Sheets            |
| `TicketAllocationService`     | Asignación RANDOM/SPECIFIC de tickets          |
| `BankStatementParserService`  | Parser de CSV/Excel de estados de cuenta       |
| `ReconciliationService`       | Matching transacciones bancarias ↔ compras     |
| `PurchasesMailListener`       | Listener de eventos para emails                |

### Exporta
`PurchasesService`, `PurchasesExportService`

---

## 10. Notas Arquitectónicas Clave

1. **Pessimistic locking** en tres puntos críticos:
   - Lock de `Raffle` durante creación de compra (evita sobreventa)
   - Lock de `Raffle` durante asignación de números aleatorios (evita colisiones)
   - Lock de `Purchase` en webhook de IA (evita race conditions)

2. **Timing de asignación de tickets:**
   - `SPECIFIC`: inmediato en la creación
   - `RANDOM`: diferido hasta que la compra pase a `VERIFIED`

3. **Multi-pago:** el array `payments[]` es el modelo actual. Los campos `bankReference` y `paymentScreenshotUrl` son legacy (`@deprecated`) pero se mantienen para compatibilidad.

4. **Idempotencia del webhook de IA:** si una compra ya está `VERIFIED`, el webhook llega tarde y no hace cambios.

5. **Exportación incremental a Sheets:** `exportedToSheets = false` se resetea cada vez que cambia el estado de una compra, para que el cron la re-exporte con el estado actualizado. Las compras `REJECTED/DUPLICATED` envían una fila vacía para limpiar la entrada del Sheet.

---

## 11. Mapa de Archivos Clave

| Archivo | Propósito |
|---------|-----------|
| `src/modules/purchases/entities/purchase.entity.ts` | Entidad central |
| `src/modules/purchases/purchases.service.ts` | Lógica de negocio principal (~700 líneas) |
| `src/modules/purchases/purchases.controller.ts` | Endpoints REST |
| `src/modules/purchases/purchases.module.ts` | Registro del módulo |
| `src/modules/purchases/purchases.cron.ts` | Exportación hourly a Google Sheets |
| `src/modules/purchases/services/purchase-verification.service.ts` | Procesamiento de webhook IA |
| `src/modules/purchases/services/ticket-allocation.service.ts` | Asignación RANDOM/SPECIFIC |
| `src/modules/purchases/services/reconciliation.service.ts` | Reconciliación bancaria |
| `src/modules/purchases/services/bank-statement-parser.service.ts` | Parser CSV/Excel |
| `src/modules/purchases/services/purchases-export.service.ts` | Exportación Excel/PDF |
| `src/modules/purchases/listeners/purchases-mail.listener.ts` | Listener de eventos |
| `src/modules/purchases/dto/create-purchase.dto.ts` | DTO de creación |
| `src/modules/raffles/utils/pricing.util.ts` | `calculatePromotionalTotal()` y enums de promoción |
| `src/modules/raffles/entities/raffle.entity.ts` | Entidad Raffle |
| `src/modules/payments/entities/payment-method.entity.ts` | Entidad PaymentMethod |
| `src/common/services/google-sheets.service.ts` | Cliente Google Sheets API |
