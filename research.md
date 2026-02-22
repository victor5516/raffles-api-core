# Research: Sistema de Promociones en Compras (Purchases)

## Objetivo

Entender en profundidad cómo funciona el sistema de promociones, con el fin de identificar qué compras se realizaron aplicando una promoción y persistir esa información en la base de datos.

---

## 1. Modelo de Datos Actual

### 1.1 Promociones en la Rifa (`raffle`)

Las promociones se configuran a nivel de rifa, no a nivel de compra individual. La migración `1769600000000-AddPromotionToRaffle.ts` añadió dos columnas a la tabla `raffle`:

| Columna              | Tipo    | Descripción                                      |
|----------------------|---------|--------------------------------------------------|
| `promotion_strategy` | VARCHAR | Tipo de estrategia: `nxm` o `percentage`         |
| `promotion_config`   | JSONB   | Configuración de la estrategia                   |

**Entidad:** `src/modules/raffles/entities/raffle.entity.ts`

```typescript
@Column({ name: 'promotion_strategy', nullable: true })
promotionStrategy: string | null;

@Column({ type: 'jsonb', nullable: true, name: 'promotion_config' })
promotionConfig: object | null;
```

### 1.2 Entidad Purchase — Estado Actual

**Entidad:** `src/modules/purchases/entities/purchase.entity.ts`

Campos relevantes actualmente presentes:

| Campo            | Tipo    | Descripción                                                 |
|------------------|---------|-------------------------------------------------------------|
| `ticketQuantity` | integer | Cantidad de tickets comprados                               |
| `totalAmount`    | numeric | Total pagado — ya refleja el descuento si había promoción   |
| `payments`       | JSONB   | Array de pagos (`PaymentEntry[]`) — sin info de promoción   |

**Brecha crítica:** la entidad `Purchase` no registra si se aplicó una promoción, cuál era ni cuánto se ahorró.

---

## 2. Estrategias de Promoción

Definidas en `src/modules/raffles/utils/pricing.util.ts`:

```typescript
export enum PromotionStrategy {
  NXM = 'nxm',           // Compra N, paga M
  PERCENTAGE = 'percentage',  // Descuento porcentual
}
```

### 2.1 Estrategia NxM (`nxm`)

**Concepto:** "Compra N boletos, paga solo M."

**Configuraciones soportadas:**

```jsonc
// Regla simple: compra 5, paga 4
{ "buy": 5, "pay": 4 }

// Reglas escalonadas (tiered)
{ "groups": [{ "buy": 3, "pay": 2 }, { "buy": 5, "pay": 4 }] }

// Formato alternativo con `rules`
{ "rules": [{ "buy": 5, "pay": 4 }] }
```

**Algoritmo de cálculo:**
1. Se extraen las reglas del config (soporta single rule, `groups[]`, `rules[]`).
2. Se ordenan las reglas por `buy` descendente (reglas más grandes primero).
3. Aplicación greedy: por cada regla, se calcula cuántos paquetes completos caben.
   ```
   packages = floor(remaining / buy)
   ticketsToPay += packages * pay
   remaining   -= packages * buy
   ```
4. Los tickets restantes se cobran a precio completo.
5. Resultado: `ticketsToPay * basePrice`.

**Ejemplo:** Rifa con regla `buy:5, pay:4`, precio $10/ticket, 12 tickets:
- Paquetes de 5: `floor(12/5) = 2` → paga 8 tickets
- Resto: 2 tickets a precio full
- Total = `(8 + 2) * 10 = $100` (en vez de $120)
- Ahorro = $20

### 2.2 Estrategia Porcentaje (`percentage`)

**Concepto:** Descuento porcentual directo sobre el total.

**Configuraciones soportadas:**

```jsonc
// Descuento simple
{ "percentage": 10 }

// Con mínimo de tickets
{ "percentage": 15, "minTickets": 10 }

// Nombre alternativo
{ "discount": 10 }
```

**Algoritmo:**
1. Si `minTickets` está definido y `quantity < minTickets` → sin descuento.
2. `total = quantity * basePrice * (1 - percentage / 100)`

---

## 3. Flujo de Aplicación en Compras

### 3.1 Al Crear una Compra

**Servicio:** `src/modules/purchases/purchases.service.ts` (aprox. líneas 108–121)

```typescript
const calculatedTotal = calculatePromotionalTotal(
  unitPriceInPaymentCurrency,
  createDto.ticket_quantity,
  raffle.promotionStrategy ?? null,
  raffle.promotionConfig ?? null,
);
const totalAmountToPersist = Number(calculatedTotal.toFixed(2));
const requestedTotalAmount = Number(createDto.totalAmount);
const totalDiff = Math.abs(requestedTotalAmount - totalAmountToPersist);

if (Number.isFinite(requestedTotalAmount) && totalDiff > 0.01) {
  throw new BadRequestException(
    'El monto total no coincide con el precio promocional vigente.',
  );
}
```

**Flujo:**
1. El cliente envía `totalAmount` (calculado en el frontend con la misma lógica).
2. El backend recalcula con los parámetros actuales de la rifa.
3. Verifica que coincidan con tolerancia ±0.01 (errores de redondeo).
4. Persiste el `totalAmount` ya con descuento aplicado.

**Consecuencia:** el `totalAmount` en DB ya está descontado pero no hay campo que indique explícitamente "esta compra usó una promoción".

### 3.2 Asignación de Tickets

**Servicio:** `src/modules/purchases/services/ticket-allocation.service.ts`

La promoción afecta únicamente el **precio**, no la cantidad de tickets asignados. La cantidad `ticketQuantity` es exactamente la cantidad de tickets entregados al cliente.

---

## 4. Cálculo en el Frontend

El frontend implementa la misma lógica en `frontend/client-raffles-v2-front/src/lib/pricing.ts` y expone un resultado extendido:

```typescript
export type PromotionalTotalResult = {
  total: number           // Total a pagar con descuento
  originalTotal: number   // Total sin descuento (quantity * unitPrice)
  savings: number         // Ahorro = originalTotal - total
  isApplied: boolean      // ¿Se aplicó la promoción?
  appliedNxmRules?: Array<{ buy: number; pay: number }>  // Reglas NxM usadas
}
```

Este resultado se muestra en el componente `TicketSelector.tsx` al momento de selección.

---

## 5. Gaps Identificados

### Lo que SÍ se guarda hoy

| Dato                        | Dónde                                |
|-----------------------------|--------------------------------------|
| Config de promoción de rifa | `raffle.promotionStrategy/Config`    |
| Total pagado (con descuento) | `purchase.totalAmount`              |
| Cantidad de tickets          | `purchase.ticketQuantity`           |

### Lo que NO se guarda (brechas)

| Dato faltante                     | Impacto                                                                 |
|-----------------------------------|-------------------------------------------------------------------------|
| Estrategia aplicada en la compra  | No se puede saber si se usó `nxm` o `percentage`                       |
| Config snapshot al momento de compra | Si la rifa cambia su promo, se pierde el historial                 |
| Monto de descuento (`savings`)    | No se puede reportar cuánto se ahorró el cliente                       |
| Total sin descuento               | No se puede calcular el precio base sin re-computar                    |
| Flag booleano `hadPromotion`      | Consultas de filtrado son costosas sin este campo                       |

---

## 6. Cómo Identificar Compras con Promoción Actualmente

Sin un campo dedicado, el único método es recalcular:

```typescript
// Para cada purchase:
const originalTotal = purchase.ticketQuantity * raffle.ticketPrice;
const promotionalTotal = calculatePromotionalTotal(
  raffle.ticketPrice,
  purchase.ticketQuantity,
  raffle.promotionStrategy,
  raffle.promotionConfig,
);
const hadPromotion = promotionalTotal < originalTotal - 0.01;
```

**Problemas de este enfoque:**
- Requiere join con la rifa en cada consulta.
- Si la rifa cambia su promoción después de la compra, el recálculo será incorrecto.
- No escala bien para reportes agregados.

---

## 7. Solución Propuesta: Columnas en `purchase`

Para persistir la información de promoción en cada compra, se propone añadir las siguientes columnas a la tabla `purchase`:

### Columnas sugeridas

| Columna                      | Tipo    | Nullable | Descripción                                              |
|------------------------------|---------|----------|----------------------------------------------------------|
| `applied_promotion_strategy` | VARCHAR | YES      | Snapshot de la estrategia usada (`nxm`, `percentage`)    |
| `applied_promotion_config`   | JSONB   | YES      | Snapshot de la configuración exacta al momento de compra |
| `discount_amount`            | NUMERIC | YES      | Monto de descuento en moneda de pago                     |
| `original_amount`            | NUMERIC | YES      | Total sin descuento (para auditoría)                     |

### Lógica de llenado (en `purchases.service.ts`)

```typescript
const originalTotal = createDto.ticket_quantity * unitPriceInPaymentCurrency;
const calculatedTotal = calculatePromotionalTotal(/* ... */);
const discountAmount = Number((originalTotal - calculatedTotal).toFixed(2));
const hadPromotion = discountAmount > 0.01;

const purchase = repo.create({
  // ... campos existentes ...
  totalAmount: calculatedTotal,
  appliedPromotionStrategy: hadPromotion ? raffle.promotionStrategy : null,
  appliedPromotionConfig:   hadPromotion ? raffle.promotionConfig   : null,
  discountAmount:           hadPromotion ? discountAmount           : null,
  originalAmount:           hadPromotion ? originalTotal            : null,
});
```

### Migración necesaria

```typescript
// src/migrations/TIMESTAMP-AddPromotionTrackingToPurchase.ts
export class AddPromotionTrackingToPurchase implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "purchase"
        ADD COLUMN "applied_promotion_strategy" VARCHAR,
        ADD COLUMN "applied_promotion_config"   JSONB,
        ADD COLUMN "discount_amount"            NUMERIC(10,2),
        ADD COLUMN "original_amount"            NUMERIC(10,2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "purchase"
        DROP COLUMN "applied_promotion_strategy",
        DROP COLUMN "applied_promotion_config",
        DROP COLUMN "discount_amount",
        DROP COLUMN "original_amount"
    `);
  }
}
```

### Backfill de datos históricos

Para las compras existentes, se puede hacer un backfill usando el script `fix-purchase-totals.ts` como referencia, siguiendo este approach:

1. Traer todas las compras con su rifa.
2. Para cada compra, recalcular `calculatePromotionalTotal()`.
3. Si `promotionalTotal < ticketQuantity * ticketPrice - 0.01`, la compra tuvo promoción.
4. Actualizar los nuevos campos (con la advertencia de que si la promoción cambió después de la compra, el snapshot puede no ser el original exacto).

---

## 8. Mapa de Archivos Clave

| Archivo | Propósito |
|---------|-----------|
| `src/migrations/1769600000000-AddPromotionToRaffle.ts` | Migración que añadió promociones a la rifa |
| `src/modules/raffles/entities/raffle.entity.ts` | Entidad Raffle con campos de promoción |
| `src/modules/raffles/utils/pricing.util.ts` | Función central `calculatePromotionalTotal()` y enums |
| `src/modules/raffles/dto/create-raffle.dto.ts` | DTO con validación de campos de promoción |
| `src/modules/raffles/raffles.service.ts` | CRUD de promociones en rifas |
| `src/modules/purchases/purchases.service.ts` | Aplica y valida la promoción al crear compras |
| `src/modules/purchases/entities/purchase.entity.ts` | Entidad Purchase (sin tracking de promo actualmente) |
| `scripts/fix-purchase-totals.ts` | Script de mantenimiento que usa la lógica de promociones |
| `frontend/client-raffles-v2-front/src/lib/pricing.ts` | Espejo exacto del cálculo en el frontend |
| `frontend/client-raffles-v2-front/src/types/raffle.types.ts` | Tipos de promoción en el frontend |

---

## 9. Resumen Ejecutivo

El sistema de promociones funciona correctamente a nivel de cálculo y validación, pero **no persiste ninguna información de la promoción aplicada en la compra**. Sólo queda implícita en el `totalAmount` final.

Para resolver esto, la implementación propuesta requiere:

1. **Migración** — añadir 4 columnas a `purchase`.
2. **Entidad** — actualizar `purchase.entity.ts` con los nuevos campos.
3. **Servicio** — en `purchases.service.ts`, calcular y persistir los nuevos campos al crear la compra.
4. **Backfill** — script para poblar datos históricos (con limitación: si la config de rifa cambió, el snapshot puede no ser exacto).
5. **API/Dashboard** — exponer métricas de descuento en el dashboard (totales descontados, compras por tipo de promo).
