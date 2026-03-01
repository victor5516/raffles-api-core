# Módulo de Cupones

## Índice

1. [Resumen](#1-resumen)
2. [Modelo de datos](#2-modelo-de-datos)
3. [Estados de un cupón](#3-estados-de-un-cupón)
4. [Estructura de archivos](#4-estructura-de-archivos)
5. [Endpoints de administración](#5-endpoints-de-administración)
6. [Endpoint público de validación](#6-endpoint-público-de-validación)
7. [Integración con compras](#7-integración-con-compras)
8. [Caso especial: compra 100% cubierta](#8-caso-especial-compra-100-cubierta)
9. [Seguridad y concurrencia](#9-seguridad-y-concurrencia)
10. [Generación de códigos](#10-generación-de-códigos)
11. [Ejemplos de uso completos](#11-ejemplos-de-uso-completos)

---

## 1. Resumen

Un cupón es un **código alfanumérico de 6 caracteres** (`[A-Z0-9]`) que un cliente puede ingresar al momento de crear una compra para obtener descuento. Cada cupón:

- Vale exactamente **1 ticket** al precio unitario de la rifa
- Es de **un solo uso** — una vez canjeado no puede reutilizarse
- No está atado a una rifa específica — aplica a cualquier rifa activa
- Tiene una **fecha de expiración** configurable al momento de creación
- Puede ser desactivado por un administrador antes de ser usado

Los cupones son un mecanismo de **descuento en el monto a pagar**, no un reemplazo del registro de compra. Una compra con cupones sigue siendo un único registro en la tabla `purchase`, con el `totalAmount` reducido en consecuencia.

---

## 2. Modelo de datos

### Tabla `coupon`

| Columna         | Tipo           | Descripción |
|-----------------|----------------|-------------|
| `code`          | `VARCHAR(6) PK`| Código único del cupón, clave primaria |
| `is_active`     | `BOOLEAN`      | `true` mientras no haya sido desactivado manualmente |
| `expires_at`    | `TIMESTAMP`    | Fecha límite de canje |
| `redeemed_at`   | `TIMESTAMP?`   | Fecha en que fue canjeado; `NULL` si no se ha usado |
| `purchase_id`   | `UUID?`        | FK a `purchase.uid`; se asigna al canjear. `NULL` hasta ese momento |
| `created_by_id` | `UUID`         | FK a `admin.uid`; quién generó el batch |
| `created_at`    | `TIMESTAMP`    | Fecha de creación |

### Relaciones

```
coupon.purchase_id → purchase.uid   (ON DELETE SET NULL)
coupon.created_by_id → admin.uid   (ON DELETE RESTRICT)
```

Si la compra asociada se elimina, `purchase_id` queda en `NULL` (el cupón queda sin compra vinculada pero conserva su historial). Un admin no puede eliminarse si tiene cupones creados.

### Índices

```sql
-- Para consultas de disponibilidad (cupones canjeables)
CREATE INDEX "IDX_coupon_is_active_expires_at"
  ON "coupon" ("is_active", "expires_at")
  WHERE "redeemed_at" IS NULL;

-- Para encontrar los cupones usados en una compra
CREATE INDEX "IDX_coupon_purchase_id"
  ON "coupon" ("purchase_id")
  WHERE "purchase_id" IS NOT NULL;
```

---

## 3. Estados de un cupón

Un cupón no tiene una columna de estado explícita — el estado se **deriva** de sus columnas:

| Estado      | Condición lógica |
|-------------|-----------------|
| `available` | `isActive = true` AND `redeemedAt IS NULL` AND `expiresAt > now()` |
| `redeemed`  | `redeemedAt IS NOT NULL` |
| `expired`   | `isActive = true` AND `redeemedAt IS NULL` AND `expiresAt <= now()` |
| `inactive`  | `isActive = false` |

El getter `isRedeemable` en la entidad encapsula esta lógica:

```typescript
get isRedeemable(): boolean {
  return this.isActive && this.redeemedAt === null && this.expiresAt > new Date();
}
```

Un cupón `redeemed` tiene prioridad sobre `expired` — si fue canjeado, se muestra como canjeado sin importar si también está vencido.

---

## 4. Estructura de archivos

```
src/modules/coupons/
├── coupons.module.ts          # Módulo NestJS; exporta CouponsService
├── coupons.controller.ts      # 6 endpoints (5 admin + 1 público)
├── coupons.service.ts         # Lógica de negocio completa
├── entities/
│   └── coupon.entity.ts       # Entidad TypeORM
└── dto/
    ├── generate-coupons.dto.ts  # count + expiresAt
    ├── filter-coupons.dto.ts    # status + search + paginación + enum CouponStatus
    └── update-coupon.dto.ts     # isActive? + expiresAt?

src/migrations/
└── 1770800000000-CreateCouponTable.ts  # Crea tabla + 2 índices parciales
```

---

## 5. Endpoints de administración

Todos requieren JWT (`Authorization: Bearer <token>`).

### `POST /api/v1/coupons/generate`

**Rol requerido:** `SUPER_ADMIN`

Genera un batch de cupones con la misma fecha de expiración. Retorna el array de códigos generados.

**Body:**
```json
{
  "count": 500,
  "expiresAt": "2026-12-31T23:59:59Z"
}
```

| Campo      | Tipo     | Restricciones         |
|------------|----------|-----------------------|
| `count`    | `number` | Entero, mínimo 1, máximo 10,000 |
| `expiresAt`| `string` | ISO 8601              |

**Response `201`:**
```json
["A3K9BZ", "X7T2QR", "P4M8YN", "..."]
```

Para generar 30,000 cupones se hacen 3 llamadas con `count: 10000` cada una.

---

### `GET /api/v1/coupons`

**Rol requerido:** cualquier admin autenticado

Lista cupones con filtros y paginación.

**Query params:**

| Param    | Tipo          | Descripción |
|----------|---------------|-------------|
| `status` | `CouponStatus`| `available`, `redeemed`, `expired`, `inactive` |
| `search` | `string`      | Búsqueda parcial por código (case-insensitive) |
| `page`   | `number`      | Página (default `1`) |
| `limit`  | `number`      | Resultados por página, máx 100 (default `20`) |

**Response `200`:**
```json
{
  "data": [
    {
      "code": "A3K9BZ",
      "isActive": true,
      "expiresAt": "2026-12-31T23:59:59.000Z",
      "redeemedAt": null,
      "purchaseId": null,
      "createdById": "uuid-del-admin",
      "createdAt": "2026-02-28T10:00:00.000Z",
      "createdBy": { "email": "admin@example.com" }
    }
  ],
  "total": 1523
}
```

**Ejemplos de filtro:**
```
GET /api/v1/coupons?status=available&limit=50
GET /api/v1/coupons?status=redeemed&page=2
GET /api/v1/coupons?search=A3K
```

---

### `GET /api/v1/coupons/:code`

**Rol requerido:** cualquier admin autenticado

Retorna el detalle completo de un cupón, incluyendo la compra asociada y el admin que lo creó.

**Response `200`:**
```json
{
  "code": "A3K9BZ",
  "isActive": true,
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "redeemedAt": "2026-03-15T14:22:00.000Z",
  "purchaseId": "uuid-de-la-compra",
  "purchase": {
    "uid": "uuid-de-la-compra",
    "submittedAt": "2026-03-15T14:22:00.000Z"
  },
  "createdById": "uuid-del-admin",
  "createdBy": { "email": "admin@example.com" },
  "createdAt": "2026-02-28T10:00:00.000Z"
}
```

**Error `404`:** si el código no existe.

---

### `PATCH /api/v1/coupons/:code`

**Rol requerido:** `SUPER_ADMIN`

Permite desactivar/reactivar un cupón o extender su fecha de expiración. **No se puede modificar un cupón ya canjeado.**

**Body (todos los campos son opcionales):**
```json
{
  "isActive": false,
  "expiresAt": "2027-06-30T23:59:59Z"
}
```

**Casos de uso:**
- Desactivar un cupón antes de que expire: `{ "isActive": false }`
- Reactivar un cupón desactivado por error: `{ "isActive": true }`
- Extender la vida de cupones próximos a vencer: `{ "expiresAt": "2027-01-01T00:00:00Z" }`

**Error `400`:** si el cupón ya fue canjeado.

---

### `DELETE /api/v1/coupons/:code`

**Rol requerido:** `SUPER_ADMIN`

Realiza un **soft-delete**: marca el cupón como `isActive = false`. El registro se conserva en la base de datos para trazabilidad.

**No se puede eliminar un cupón ya canjeado** — forma parte del audit trail de la compra.

**Response `200`:** vacío.

**Error `400`:** si el cupón ya fue canjeado.

---

## 6. Endpoint público de validación

### `GET /api/v1/coupons/validate/:code`

**Sin autenticación requerida.** Diseñado para que el frontend muestre un preview del descuento antes de que el cliente envíe la compra.

**Response cuando el cupón es válido:**
```json
{
  "code": "A3K9BZ",
  "isValid": true,
  "expiresAt": "2026-12-31T23:59:59.000Z"
}
```

**Response cuando el cupón no es válido:**
```json
{
  "code": "XXXYYY",
  "isValid": false,
  "reason": "expired"
}
```

| `reason`    | Significado |
|-------------|-------------|
| `not_found` | El código no existe en la base de datos |
| `inactive`  | El admin desactivó el cupón (`isActive = false`) |
| `redeemed`  | Ya fue canjeado en una compra anterior |
| `expired`   | La fecha de expiración ya pasó |

> Este endpoint **nunca devuelve 404** para los códigos inválidos — siempre retorna `200` con `isValid: false`. Esto evita que un atacante distinga entre "código no existe" vs "código existe pero fue usado", dificultando la enumeración.

---

## 7. Integración con compras

Los cupones se aplican al crear una compra mediante el campo `couponCodes` en `POST /api/v1/purchases`.

### Campo en `CreatePurchaseDto`

```json
{
  "raffleId": "uuid-de-la-rifa",
  "paymentMethodId": "uuid-del-metodo",
  "ticket_quantity": 5,
  "totalAmount": 150.00,
  "customer": { ... },
  "couponCodes": ["A3K9BZ", "X7T2QR"]
}
```

| Restricción | Detalle |
|-------------|---------|
| Opcional | Si se omite o es array vacío, no se aplica descuento |
| Máximo | 100 códigos por request (validación en DTO) |
| Límite lógico | No se pueden usar más cupones que `ticket_quantity` |
| Deduplicación | Duplicados se eliminan automáticamente (case-insensitive) |

### Cálculo del descuento

El descuento por cupones se aplica **después** del descuento por promoción de la rifa:

```
unitPrice = raffle.ticketPrice × paymentMethod.currency.value
promotionalTotal = calculatePromotionalTotal(unitPrice, quantity, strategy, config)
couponDiscount = couponCount × unitPrice
finalTotal = max(0, promotionalTotal - couponDiscount)
```

**Ejemplos:**

| Escenario | `totalAmount` |
|-----------|---------------|
| 5 tickets a $10, sin nada | `$50.00` |
| 5 tickets a $10, promo 5x4 | `$40.00` |
| 5 tickets a $10, sin promo, 2 cupones | `$30.00` |
| 5 tickets a $10, promo 5x4, 2 cupones | `$20.00` |
| 3 tickets a $10, sin promo, 3 cupones | `$0.00` |

El campo `totalAmount` enviado por el cliente **debe coincidir** con el `finalTotal` calculado por el backend (tolerancia ±0.01). Si no coincide, se lanza `400 Bad Request`.

### Flujo interno de una compra con cupones

```
POST /purchases
│
├─ TRANSACCIÓN
│   ├─ 1. Validar rifa (lock)
│   ├─ 2. Calcular promotionalTotal
│   ├─ 3. validateAndLock(couponCodes)   ← SELECT ... FOR UPDATE
│   │      Verifica: existe, isActive, no canjeado, no expirado
│   ├─ 4. Calcular finalTotal = promotionalTotal - couponDiscount
│   ├─ 5. Validar totalAmount del cliente vs finalTotal
│   ├─ 6. Determinar tickets (SPECIFIC o RANDOM)
│   ├─ 7. Crear Customer si no existe
│   ├─ 8. Subir comprobante a S3
│   ├─ 9. Crear y guardar Purchase con totalAmount = finalTotal
│   ├─ 10. redeemCoupons() ← UPDATE SET redeemed_at, purchase_id
│   └─ 11. Si finalTotal = 0: auto-verificar (ver §8)
│
└─ POST-TRANSACCIÓN
    ├─ Si ya VERIFIED: emitir purchase.status_changed (sin SQS)
    └─ Si PENDING: enviar a SQS para verificación por IA
```

### Respuesta de `GET /purchases/:uid`

Las compras que usaron cupones incluyen el campo `redeemedCoupons` en su respuesta:

```json
{
  "uid": "uuid-de-la-compra",
  "totalAmount": 20.00,
  "status": "VERIFIED",
  "redeemedCoupons": [
    { "code": "A3K9BZ", "redeemedAt": "2026-03-15T14:22:00.000Z" },
    { "code": "X7T2QR", "redeemedAt": "2026-03-15T14:22:00.000Z" }
  ]
}
```

El listado de compras (`GET /purchases`) **no** carga cupones para evitar N+1 queries.

---

## 8. Caso especial: compra 100% cubierta

Cuando `finalTotal === 0` (todos los tickets cubiertos por cupones), la compra **no requiere pago bancario** y se auto-verifica dentro de la misma transacción:

```
finalTotal = 0
→ purchase.status = VERIFIED
→ purchase.verificationSource = BY_SYSTEM
→ purchase.verifiedAt = now()
→ Si rifa RANDOM y sin tickets asignados aún: assignRandomNumbers()
→ manager.save(Purchase)   ← segunda escritura en la misma transacción
→ NO se envía a SQS (sin comprobante que verificar)
→ Se emite evento purchase.status_changed en lugar de purchase.created
```

**Comportamiento visible:**
- La compra llega al cliente ya en estado `VERIFIED`
- Para rifas RANDOM, los tickets quedan asignados inmediatamente
- Para rifas SPECIFIC, los tickets ya estaban reservados desde el paso 6
- El campo `payments[]` puede venir vacío o con `amount: 0`

---

## 9. Seguridad y concurrencia

### Race condition

El escenario más crítico: dos compras simultáneas intentan usar el mismo cupón.

**Solución:** `SELECT ... FOR UPDATE` (pessimistic write lock) dentro de la transacción de creación de la compra:

```typescript
manager.find(Coupon, {
  where: { code: In(codes) },
  lock: { mode: 'pessimistic_write' },
});
```

La primera transacción que llega adquiere el lock. La segunda queda en espera. Cuando la primera hace commit (marcando el cupón como canjeado), la segunda obtiene el lock, re-evalúa las condiciones y lanza `400 Bad Request` porque `redeemedAt` ya no es `NULL`.

### Brute force

El endpoint `GET /validate/:code` es público y podría usarse para adivinar códigos.

- Espacio de códigos: 36⁶ = **2,176,782,336** combinaciones
- Con rate limiting de 10 req/min por IP: recorrer el espacio completo tomaría **~414 años**
- El endpoint nunca distingue entre "no existe" y "existe pero no válido" — siempre devuelve `isValid: false` con una razón que no permite enumerar si el código alguna vez existió

**El rate limiting debe configurarse a nivel de Nginx** (o mediante un `ThrottlerGuard` de NestJS) — no está implementado en el módulo en sí.

### Generación segura

Los códigos se generan con `crypto.randomBytes()` (CSPRNG), no con `Math.random()`. Esto garantiza uniformidad criptográfica en la selección de caracteres.

---

## 10. Generación de códigos

### Algoritmo

```typescript
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 36 chars

function generateCode(): string {
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes)
    .map((b) => CHARSET[b % 36])
    .join('');
}
```

Cada byte aleatorio se mapea a uno de los 36 caracteres del charset. El módulo `% 36` introduce un sesgo marginal (256 no es divisible por 36), pero con ~7.1 posiciones por carácter el sesgo es de ~0.3% — aceptable para este dominio.

### Manejo de colisiones en batch

Al generar un batch:

1. Se generan `N` códigos en un `Set` (garantía de unicidad local)
2. Se consulta la BD con `SELECT code FROM coupon WHERE code IN (candidatos)`
3. Los que ya existen en BD se descartan
4. Se regeneran los faltantes en un loop usando un segundo `Set` para O(1) de deduplicación

Con 36⁶ ≈ 2.1B de espacio y un máximo de 10,000 por batch, la probabilidad de colisión es despreciable en la práctica.

### Límites

| Operación | Límite |
|-----------|--------|
| Cupones por llamada a `/generate` | 10,000 |
| Cupones por compra (`couponCodes`) | 100 (DTO) / `ticket_quantity` (lógica) |
| Longitud del código | 6 caracteres fijos |
| Charset | `[A-Z0-9]` (36 caracteres, mayúsculas únicamente) |

---

## 11. Ejemplos de uso completos

### Flujo 1: generar y distribuir cupones

```bash
# 1. Autenticarse
TOKEN=$(curl -s -X POST /api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"..."}' \
  | jq -r '.access_token')

# 2. Generar 500 cupones válidos hasta fin de año
CODES=$(curl -s -X POST /api/v1/coupons/generate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"count": 500, "expiresAt": "2026-12-31T23:59:59Z"}')

# 3. Distribuir los códigos por el canal que corresponda
echo $CODES | jq '.[]'
```

### Flujo 2: cliente valida y usa un cupón

```bash
# El cliente ingresa el código en el frontend
# El frontend llama al endpoint público para mostrar preview
curl /api/v1/coupons/validate/A3K9BZ
# → { "code": "A3K9BZ", "isValid": true, "expiresAt": "2026-12-31T..." }

# El cliente confirma la compra (5 tickets, 2 cupones)
# totalAmount = 5 × $10 - 2 × $10 = $30
curl -X POST /api/v1/purchases \
  -H "Content-Type: application/json" \
  -d '{
    "raffleId": "uuid-rifa",
    "paymentMethodId": "uuid-pm",
    "ticket_quantity": 5,
    "totalAmount": 30.00,
    "customer": {
      "national_id": "12345678",
      "full_name": "Juan Pérez",
      "email": "juan@example.com"
    },
    "bank_reference": "REF999",
    "couponCodes": ["A3K9BZ", "X7T2QR"]
  }'
```

### Flujo 3: consultar cupones usados

```bash
# Ver todos los cupones canjeados
curl -H "Authorization: Bearer $TOKEN" \
  "/api/v1/coupons?status=redeemed&page=1&limit=100"

# Ver el detalle de un cupón específico
curl -H "Authorization: Bearer $TOKEN" \
  "/api/v1/coupons/A3K9BZ"
# → incluye purchase.uid y purchase.submittedAt

# Ver los cupones canjeados en una compra específica
curl -H "Authorization: Bearer $TOKEN" \
  "/api/v1/purchases/uuid-de-la-compra"
# → incluye redeemedCoupons: [{ code, redeemedAt }]
```

### Flujo 4: desactivar cupones de un batch comprometido

```bash
# Si se filtra una lista de códigos, desactivarlos todos
while IFS= read -r code; do
  curl -s -X DELETE \
    -H "Authorization: Bearer $TOKEN" \
    "/api/v1/coupons/$code"
done < codigos_comprometidos.txt
```

### Flujo 5: compra 100% cubierta por cupones

```bash
# 3 tickets, 3 cupones → totalAmount = 0
curl -X POST /api/v1/purchases \
  -H "Content-Type: application/json" \
  -d '{
    "raffleId": "uuid-rifa",
    "paymentMethodId": "uuid-pm",
    "ticket_quantity": 3,
    "totalAmount": 0,
    "customer": { ... },
    "couponCodes": ["A3K9BZ", "X7T2QR", "P4M8YN"]
  }'

# Response: status = "VERIFIED", verificationSource = "BY_SYSTEM"
# Para rifas RANDOM: ticketNumbers ya asignados en la respuesta
```
