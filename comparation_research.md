# Investigación Profunda: Sistema de Conciliación Bancaria

## Resumen ejecutivo

El sistema de conciliación (`reconciliation.service.ts`) cruza transacciones de un estado de cuenta bancario contra compras almacenadas en la DB. El **índice de aciertos es bajo** principalmente porque el matching requiere que **tanto el monto como la referencia coincidan simultáneamente**, y existen múltiples puntos donde cada condición puede fallar de forma silenciosa.

---

## Flujo completo del proceso

```
Estado de cuenta (archivo)
    ↓
BankStatementParserService (Gemini AI)
    → extrae: { date, amount, reference, description }
    ↓
ReconciliationService.matchTransactions()
    → para cada transacción bancaria:
        → normaliza referencia bancaria (normalizeRef)
        → busca en todas las compras de DB (por raffleId + paymentMethodId)
            → extrae referencias de cada compra (extractPurchaseReferences)
            → normaliza referencia de compra (normalizeRef)
            → compara montos (diff ≤ 0.01)  ← CONDICIÓN 1
            → compara referencias (sufijo ≥ 7 chars)  ← CONDICIÓN 2
        → si AMBAS coinciden → match ✓
        → si alguna falla → unmatchedBank ✗
```

---

## Cómo se extraen las referencias de las compras (DB)

Función: `extractPurchaseReferences()` — líneas 211–251

### Prioridad 1: `aiAnalysisResult.data.reference`

```typescript
if (purchase.aiAnalysisResult?.data?.reference) {
  // Usa SÓLO esta referencia y monto (ai.data.amount ?? totalPaid ?? totalAmount)
  return refs; // ← early return, NO consulta payments[]
}
```

**Problema crítico**: Si el OCR de la IA leyó mal la referencia del comprobante (dígito ilegible, sombra, pixelado), ese error queda almacenado permanentemente en `aiAnalysisResult.data.reference` y **se usa como única fuente de verdad**, ignorando todo lo demás.

### Prioridad 2: `payments[]` array

Solo se usa si NO hay `aiAnalysisResult`. Itera cada `{ reference, amount }` de los pagos individuales.

### ¿Qué campos NUNCA se consultan?

- `purchase.bankReference` (campo legacy `bank_reference`) — **IGNORADO** completamente en conciliación
- `payments[].aiResult` — no se extrae referencia de aquí
- `purchase.notes` — no se busca referencia aquí

---

## Cómo se normalizan las referencias

Función: `normalizeRef()` — líneas 163–170

```typescript
private normalizeRef(value: string | null | undefined): string {
  const str = String(value);
  const normalized = str.normalize('NFKC');   // normalización Unicode
  const upper = normalized.toUpperCase();      // todo mayúsculas
  const cleaned = upper.replace(/[^A-Z0-9]/g, ''); // elimina TODO lo que no sea letra o número
  return cleaned || '';
}
```

**Qué se elimina**: espacios, guiones, puntos, barras, comas, cualquier carácter especial.

**Ejemplos:**
- `"00510 128-2438"` → `"005101282438"`
- `"000084731282438"` → `"000084731282438"`
- `"REF-00123/2024"` → `"REF001232024"` ← OJO: letras incluidas si las hay

---

## Cómo se comparan las referencias (sufijo)

Función: `isReferenceMatch()` / `commonSuffixLength()` — líneas 176–203

```typescript
private commonSuffixLength(a: string, b: string): number {
  let i = a.length - 1;
  let j = b.length - 1;
  let count = 0;
  while (i >= 0 && j >= 0 && a[i] === b[j]) {
    count++;
    i--;
    j--;
  }
  return count;
}

private readonly MIN_SUFFIX_MATCH_LENGTH = 7;

private isReferenceMatch(normA: string, normB: string): boolean {
  if (!normA || !normB) return false;
  return this.commonSuffixLength(normA, normB) >= this.MIN_SUFFIX_MATCH_LENGTH;
}
```

**Lógica**: cuenta cuántos caracteres **del final** de ambas referencias son iguales consecutivamente. Si son ≥ 7 → match.

**Ejemplo correcto:**
```
DB ref:    "005101282438"      (normalizada)
Banco ref: "000084731282438"   (normalizada)
                   ^^^^^^^
                   1282438  ← 7 chars de sufijo común → MATCH ✓
```

**Ejemplo de fallo silencioso:**
```
DB ref (AI OCR):   "005101282439"  ← OCR leyó "9" en vez de "8"
Banco ref:          "000084731282438"
                           ^^^^^^x
                           sufijo = 6 chars → NO MATCH ✗
```

---

## Cómo se compara el monto

```typescript
const amountDiff = Math.abs(bankAmount - purchaseAmount);
const amountMatches = amountDiff <= 0.01;
```

**Fuente del monto en la compra:**
- Si hay `aiAnalysisResult`: usa `ai.data.amount ?? purchase.totalPaid ?? purchase.totalAmount`
- Si hay `payments[]`: usa `payment.amount` de cada entrada individual

**Tolerancia**: exactamente ±0.01 (un centavo).

---

---

## Estado actual de implementación (Feb 2026)

Las siguientes mejoras propuestas en este documento **ya fueron implementadas** en `reconciliation.service.ts`:

| Mejora | Estado | Detalle |
|--------|--------|---------|
| Causa 4: `bankReference` ignorado | ✅ Implementado | `extractPurchaseReferences()` incluye `purchase.bankReference` como Candidato 3 (líneas 252–256) |
| Causa 5: Sin fallback de descripción bancaria | ✅ Implementado | `matchTransactions()` hace `tx.reference \|\| this.extractRefFromDescription(tx.description)` (líneas 298–304). `extractRefFromDescription()` extrae la secuencia numérica más larga (≥7 dígitos) del campo descripción |
| Causa 2: AI early-return ignora `payments[]` | ✅ Implementado | `extractPurchaseReferences()` ya NO tiene early-return. Colecta candidatos de: (1) `aiAnalysisResult.data.reference`, (2) `payments[].reference`, (3) `bankReference` — todos acumulados en `refs[]` |
| Tolerancia de monto ±0.01 (Causa 3) | ✅ Aumentada | `AMOUNT_TOLERANCE = 1.0` (antes 0.01) — cubre redondeos bancarios en Bs |
| Mejora 5: "posible match" sin auto-verificar | ❌ Pendiente | Si referencia hace match pero monto difiere, todavía cae en `unmatchedBank`. No existe estado "posible match" para revisión manual |

---

## Diagnóstico de causas del bajo índice de aciertos

### Causa 1: La IA OCR guarda una referencia incorrecta (más impactante)

Cuando el comprobante de pago tiene imagen de baja calidad, la Lambda OCR puede leer un dígito incorrecto en la referencia. Ese valor incorrecto se guarda en `aiAnalysisResult.data.reference` y se usa como fuente única. Por el early return, **ni siquiera se intenta** comparar contra lo que el usuario escribió en `payments[].reference`.

### Causa 2: `aiAnalysisResult` presente pero `payments[]` tiene la referencia correcta

Cuando la compra fue procesada por IA **y además** tiene `payments[]`, el código usa **solo** el resultado de IA. Si el usuario corrigió manualmente la referencia en `payments[]`, esa corrección es ignorada en conciliación.

### Causa 3: Monto no coincide para pagos en Bs

Para pagos en bolívares:
- El monto almacenado en DB puede estar en Bs del momento del pago
- El monto en el estado de cuenta puede tener decimales diferentes por redondeo bancario
- La tolerancia ±0.01 es apropiada para USD/EUR pero puede fallar si hay ligeras diferencias de centavos en Bs (ej.: tasa aplicada difiere en el cálculo)
- Si la compra tiene `totalPaid = 150.00` y el banco muestra `150.05`, **no hay match** aunque sea el mismo pago

### Causa 4: Campo `bankReference` legacy ignorado ✅ RESUELTO

~~Compras antiguas pueden tener la referencia solo en `purchase.bankReference` (campo legacy). Esta columna nunca se consultaba en el proceso de reconciliación.~~

**Implementado**: `extractPurchaseReferences()` ahora incluye `bankReference` como Candidato 3. Si `aiAnalysisResult` es null Y `payments[]` está vacío pero hay `bankReference`, éste se usa.

### Causa 5: Referencia bancaria no extraída por Gemini ✅ RESUELTO

~~Si el estado de cuenta tiene la referencia embebida solo en la descripción, Gemini puede devolver `reference: ""` y la transacción cae directamente a `unmatchedBank` sin intentar ningún fallback.~~

**Implementado**: `matchTransactions()` ahora usa `tx.reference || this.extractRefFromDescription(tx.description)`. La función `extractRefFromDescription()` extrae la secuencia numérica más larga (≥7 dígitos) encontrada en la descripción como referencia candidata.

### Causa 6: Compras con múltiples pagos (split payments)

Si una compra tiene `payments = [{ ref: "A", amount: 100 }, { ref: "B", amount: 50 }]` y la transacción bancaria es por 100 con ref "A", el código compara `bankAmount = 100` vs `payment.amount = 100` para ref "A" → debería hacer match. Pero si se buscó primero la entrada "B" (amount=50), falla el monto y puede que no continúe correctamente. La lógica hace `break` al primer match de referencia+monto, lo cual es correcto, pero si el primer `payment` en el array NO coincide en monto, sigue al siguiente, lo cual también es correcto. Este caso debería funcionar.

### Causa 7: Monto extraído por IA del comprobante vs monto real bancario

Para pagos en Bs, el monto que la IA OCR extrae del comprobante (lo que ve en la imagen del voucher) puede diferir del monto que efectivamente acreditó el banco si hubo:
- Comisiones bancarias descontadas
- Redondeos del banco receptor
- El banco muestra "monto enviado" vs "monto acreditado"

---

## Tabla resumen: fuentes de datos por escenario

| Escenario de compra | Referencia usada | Monto usado |
|---------------------|-----------------|-------------|
| Con `aiAnalysisResult` | `ai.data.reference` (ÚNICO) | `ai.data.amount` → `totalPaid` → `totalAmount` |
| Sin AI, con `payments[]` | `payment.reference` (cada uno) | `payment.amount` (individual) |
| Sin AI, sin payments[], solo `bankReference` | **NINGUNA** — se saltea | — |

---

## Propuestas de mejora para pagos en Bs

### Mejora 1: ✅ IMPLEMENTADA — Usar todos los candidatos de referencia (AI + payments[] + bankReference)

~~En lugar del early return, agregar todas las referencias como candidatos.~~

**Implementado**: No hay early-return. Se colectan referencias de `aiAnalysisResult.data.reference`, `payments[].reference`, y `bankReference` acumuladas en un array con su monto asociado.

### Mejora 2: ✅ IMPLEMENTADA — Incluir `bankReference` como candidato

~~Agregar `purchase.bankReference` al array de referencias candidatas.~~

**Implementado**: Ver Mejora 1.

### Mejora 3: ✅ IMPLEMENTADA (parcialmente) — Tolerancia aumentada para Bs

~~Para pagos en Bs, el monto puede tener variaciones mayores a ±0.01 debido a redondeos bancarios.~~

**Implementado parcialmente**: `AMOUNT_TOLERANCE = 1.0` (aumentado de 0.01). No es configurable por `paymentMethod` todavía.

### Mejora 4: ✅ IMPLEMENTADA — Fallback de descripción bancaria

~~Cuando Gemini no extrae referencia explícita, intentar buscar secuencias numéricas de ≥7 dígitos dentro de `tx.description`.~~

**Implementado**: Ver Causa 5 arriba.

### Mejora 5: ❌ PENDIENTE — Match solo por referencia cuando monto es inconsistente

Para el caso de Bs: si la referencia (sufijo 7) hace match pero el monto difiere, no auto-verificar sino poner en estado `MANUAL_REVIEW` o marcar como "posible match" en el resultado, para que un admin lo revise manualmente. Actualmente un "posible match" simplemente cae en `unmatchedBank`.

### Mejora 6: Reducir `MIN_SUFFIX_MATCH_LENGTH` de forma condicional

Si se detecta que ambas referencias normalizadas tienen exactamente 7 dígitos del mismo sufijo en común pero la longitud total de una es mucho mayor, el match sigue siendo válido. El umbral actual de 7 es correcto para Bs según lo que indica el usuario, pero el problema raíz no está en este número sino en las causas 1-5 arriba.

---

## Puntos de entrada de datos para depuración

Para diagnosticar qué está fallando en un caso concreto:

1. **¿La compra tiene `aiAnalysisResult`?** → Si sí, ver `aiAnalysisResult.data.reference` y `aiAnalysisResult.data.amount`
2. **¿Tiene `payments[]`?** → Ver cada `{ reference, amount }` en el array
3. **¿Tiene `bankReference`?** → Recordar que este campo NO se usa en reconciliación actual
4. **¿El banco devuelve referencia?** → Ver `tx.reference` después del parseo Gemini (loggear en `matchTransactions`)
5. **Normalizar manualmente**: aplicar `.toUpperCase().replace(/[^A-Z0-9]/g, '')` a ambas referencias y ver si comparten ≥7 chars al final

---

## Archivos clave del sistema

| Archivo | Responsabilidad |
|---------|----------------|
| `services/reconciliation.service.ts` | Lógica central de matching, normalización y auto-verificación |
| `services/reconciliation-job.service.ts` | CRUD de jobs, enqueue (fire-and-forget), recovery de jobs colgados |
| `services/bank-statement-parser.service.ts` | Parseo del archivo bancario via Gemini AI |
| `listeners/reconciliation-job.listener.ts` | Worker asíncrono: escucha `reconciliation.process` y ejecuta la conciliación en background |
| `events/reconciliation.events.ts` | Constantes de eventos y tipos del payload |
| `entities/reconciliation-job.entity.ts` | Entidad `reconciliation_jobs` con status, resultado JSONB y metadatos |
| `dto/reconciliation.dto.ts` | Tipos `BankTransaction`, `ReconciliationResult` |
| `dto/reconciliation-job.dto.ts` | DTOs de respuesta: `ReconciliationJobResponseDto`, `ReconciliationJobCreatedDto` |
| `entities/purchase.entity.ts` | Entidad Purchase con campos `aiAnalysisResult`, `payments[]`, `bankReference` |
| `purchases.controller.ts` | Endpoints de conciliación asíncrona |

---

## Sistema de Worker Asíncrono (implementado Feb 2026)

### Problema resuelto

El endpoint `POST /reconcile` era síncrono: esperaba a que Gemini AI parseara el CSV/Excel y ejecutara todo el matching antes de responder. Con estados de cuenta grandes (>200 transacciones), esto causaba timeouts HTTP y UX bloqueante.

### Arquitectura implementada

```
Frontend
  │
  │  POST /reconcile (multipart) ──► HTTP 202 + { jobId, statusUrl }
  │                                        ↓
  │                               ReconciliationJobService.enqueue()
  │                                   ├─ Guarda job en DB (status=processing)
  │                                   └─ eventEmitter.emit('reconciliation.process', payload)
  │                                              ↓  (fire-and-forget, no await)
  │                                   ReconciliationJobListener
  │                                       └─ reconciliationService.reconcile()
  │                                           ├─ BankStatementParserService (Gemini AI)
  │                                           ├─ matchTransactions()
  │                                           └─ markComplete() / markFailed()
  │
  │  GET /reconcile/jobs/:jobId ──► { status: 'processing' | 'ready' | 'failed', result }
  │  (polling cada 3s hasta status !== 'processing')
```

**Patrón usado**: EventEmitter2 fire-and-forget — el mismo patrón que `PurchasesMailListener` y `purchase.created`. `emit()` dispara el handler `@OnEvent` pero **no awaita** la Promise retornada, por lo que el proceso corre en background mientras el HTTP response ya fue enviado.

### Recovery de jobs colgados

`ReconciliationJobService` implementa `OnModuleInit`: al iniciar la app, cualquier job con `status=processing` y `startedAt` hace más de 15 minutos se marca automáticamente como `failed`. Esto cubre reinicios de proceso durante un job activo.

### Nuevos archivos creados

| Archivo | Descripción |
|---------|-------------|
| `events/reconciliation.events.ts` | `RECONCILIATION_EVENTS` objeto con constantes de nombre de evento; `ReconciliationProcessEvent` interface |
| `entities/reconciliation-job.entity.ts` | Tabla `reconciliation_jobs`: `uid`, `raffle_id`, `payment_method_id`, `file_name`, `file_mime_type`, `status` (enum), `result` (JSONB), `error_message`, `created_by`, `started_at`, `completed_at` |
| `migrations/1770900000000-CreateReconciliationJobTable.ts` | Migración SQL para crear la tabla y el enum PostgreSQL |
| `dto/reconciliation-job.dto.ts` | `ReconciliationJobResponseDto` y `ReconciliationJobCreatedDto` |
| `services/reconciliation-job.service.ts` | `enqueue()`, `markComplete()`, `markFailed()`, `findOne()`, `findAll()`, recovery `OnModuleInit` |
| `listeners/reconciliation-job.listener.ts` | `@OnEvent('reconciliation.process')` handler que ejecuta `reconciliationService.reconcile()` |

---

## Referencia de API para el Frontend

> Base path: `/api/v1/purchases`
> Todos los endpoints requieren `Authorization: Bearer <jwt>`.

---

### `POST /reconcile` — Iniciar conciliación asíncrona

Sube el estado de cuenta bancario. Responde inmediatamente con un `jobId`; el procesamiento ocurre en background.

**Request**: `multipart/form-data`

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `file` | `File` | ✅ | Archivo CSV o Excel del estado de cuenta bancario |
| `paymentMethodId` | `string` (UUID) | ✅ | UID del método de pago a conciliar |
| `raffleId` | `string` (UUID) | ✅ | UID de la rifa para filtrar compras |

**Response 202 Accepted**:
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "statusUrl": "/api/v1/purchases/reconcile/jobs/550e8400-e29b-41d4-a716-446655440000"
}
```

**Errores**:
- `400` — archivo, `paymentMethodId` o `raffleId` faltante
- `401` — token inválido o expirado
- `403` — rol sin permisos

---

### `GET /reconcile/jobs/:jobId` — Consultar estado de un job

Endpoint de polling. El frontend debe llamarlo cada ~3 segundos hasta que `status !== 'processing'`.

**Params**: `jobId` — UUID devuelto por `POST /reconcile`

**Response 200**:
```json
{
  "uid": "550e8400-e29b-41d4-a716-446655440000",
  "raffleId": "rifa-uid-123",
  "paymentMethodId": "pago-uid-456",
  "fileName": "estado_cuenta_enero.csv",
  "status": "processing",
  "result": null,
  "errorMessage": null,
  "createdAt": "2026-02-28T14:30:00.000Z",
  "completedAt": null
}
```

**Valores de `status`**:

| Valor | Significado | Qué hacer |
|-------|-------------|-----------|
| `processing` | Job en cola o ejecutándose | Seguir haciendo polling |
| `ready` | Conciliación completada con éxito | Leer `result` y mostrar resultados |
| `failed` | Error durante el procesamiento | Leer `errorMessage` y mostrar al usuario |

**Estructura de `result`** (cuando `status === 'ready'`):
```json
{
  "matched": [
    {
      "purchase": { "uid": "...", "customer": { "name": "..." }, "totalAmount": 150.00 },
      "bankTransaction": { "date": "2026-01-15", "amount": 150.00, "reference": "000123456789", "description": "PAGO REF 123456789" }
    }
  ],
  "unmatchedBank": [
    { "date": "2026-01-16", "amount": 75.50, "reference": "000987654321", "description": "..." }
  ],
  "unmatchedPurchases": [
    { "uid": "...", "customer": { "name": "..." }, "totalAmount": 200.00, "status": "pending" }
  ]
}
```

**Errores**:
- `404` — `jobId` no existe
- `401` — token inválido

---

### `GET /reconcile/jobs` — Historial de jobs

Lista los jobs de conciliación más recientes (útil para mostrar un historial en UI).

**Query params** (todos opcionales):

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `raffleId` | `string` | Filtrar por rifa |
| `paymentMethodId` | `string` | Filtrar por método de pago |
| `limit` | `number` | Máximo de resultados (default: `20`) |

**Response 200**: Array de objetos con la misma estructura que `GET /reconcile/jobs/:jobId`.

---

### Ejemplo de flujo completo (JavaScript/TypeScript)

```typescript
// 1. Subir el estado de cuenta
const formData = new FormData();
formData.append('file', csvFile);
formData.append('raffleId', selectedRaffleId);
formData.append('paymentMethodId', selectedPaymentMethodId);

const { jobId, statusUrl } = await fetch('/api/v1/purchases/reconcile', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: formData,
}).then(res => res.json());

// 2. Polling hasta que el job termine
const poll = async (): Promise<ReconciliationJob> => {
  const job = await fetch(`/api/v1${statusUrl}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(res => res.json());

  if (job.status === 'processing') {
    await new Promise(resolve => setTimeout(resolve, 3000));
    return poll();
  }
  return job;
};

const completedJob = await poll();

// 3. Manejar resultado
if (completedJob.status === 'ready') {
  const { matched, unmatchedBank, unmatchedPurchases } = completedJob.result;
  // mostrar resultados...
} else {
  // completedJob.status === 'failed'
  console.error(completedJob.errorMessage);
}
```
