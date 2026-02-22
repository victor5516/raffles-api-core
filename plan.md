# Plan: Tracking de Promoción en Compras con JSONB

## Objetivo

Persistir en cada `Purchase` un snapshot de la promoción que se aplicó al momento de la compra, usando una sola columna JSONB `promotion_snapshot`. Esto permite identificar compras con promoción sin recalcular y sin alterar la lógica existente de negocio.

---

## Diseño de la Solución

### Por qué JSONB y no columnas separadas

- Una sola columna evita `ALTER TABLE` múltiple y mantiene la entidad limpia.
- El snapshot es una unidad coherente: no tiene sentido guardar `discountAmount` sin `strategy`.
- Si en el futuro la estructura cambia (nueva estrategia), no requiere nueva migración.
- Consistente con el patrón ya usado en el proyecto (`payments`, `aiAnalysisResult`, `promotionConfig`).

### Estructura del snapshot

```typescript
export interface PromotionSnapshot {
  strategy: string;        // 'nxm' | 'percentage'
  config: object;          // Snapshot de la config exacta en el momento de la compra
  originalAmount: number;  // Monto sin descuento
  discountAmount: number;  // Ahorro = originalAmount - totalAmount
}
```

- `null` cuando no hubo promoción (raffle sin promo, o promo que no aplica por minTickets).
- Los valores son computados por el backend en el momento de creación — **no vienen del cliente**.

---

## Archivos a Modificar / Crear

| Acción    | Archivo                                                         |
|-----------|-----------------------------------------------------------------|
| CREAR     | `src/migrations/TIMESTAMP-AddPromotionSnapshotToPurchase.ts`    |
| MODIFICAR | `src/modules/purchases/entities/purchase.entity.ts`             |
| MODIFICAR | `src/modules/purchases/purchases.service.ts` (solo método `create`) |
| CREAR     | `scripts/backfill-promotion-snapshots.ts`                       |

> `PromotionSnapshot` se define directamente en `purchase.entity.ts`, igual que `PaymentEntry`. No se crea directorio `interfaces/` separado.

---

## Paso 1 — Entidad

Agregar la interfaz y el campo en `purchase.entity.ts`, siguiendo el mismo patrón de `PaymentEntry` que ya vive en ese archivo.

```typescript
// Agregar junto a PaymentEntry, al inicio del archivo

export interface PromotionSnapshot {
  strategy: string;
  config: object;
  originalAmount: number;
  discountAmount: number;
}
```

```typescript
// Dentro de la clase Purchase, después de totalAmount:

@Column({ type: 'jsonb', nullable: true, name: 'promotion_snapshot' })
promotionSnapshot: PromotionSnapshot | null;
```

Con `synchronize: true` activo, el servidor aplica el `ALTER TABLE` automáticamente al reiniciar. No se necesita ejecutar la migración en desarrollo.

---

## Paso 2 — Migración

Se crea el archivo para mantener el historial al día y para poder ejecutarla en producción (donde `synchronize` es `false`). El timestamp debe ser mayor que el último: `1770500000000`.

```typescript
// src/migrations/1770600000000-AddPromotionSnapshotToPurchase.ts
import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddPromotionSnapshotToPurchase1770600000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'purchase',
      new TableColumn({
        name: 'promotion_snapshot',
        type: 'jsonb',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('purchase', 'promotion_snapshot');
  }
}
```

> No ejecutar en dev.

---

## Paso 3 — Servicio

El único cambio está en el método `create()`, justo después de la validación de `totalDiff` (líneas 108–121 actuales). Las variables `calculatedTotal`, `totalAmountToPersist` y `unitPriceInPaymentCurrency` ya existen — solo se derivan el snapshot.

Se usa `Number(x.toFixed(2))` para el redondeo, igual que el resto del servicio y los scripts existentes. **No se modifica `pricing.util.ts`**.

### Lógica a insertar (después de la validación de `totalDiff`):

```typescript
// Dentro del transaction de create(), después de la validación de totalDiff

const originalAmount = Number(
  (unitPriceInPaymentCurrency * createDto.ticket_quantity).toFixed(2),
);
const discountAmount = Number(
  (originalAmount - totalAmountToPersist).toFixed(2),
);
const promotionSnapshot: PromotionSnapshot | null =
  discountAmount > 0.01 && raffle.promotionStrategy
    ? {
        strategy: raffle.promotionStrategy,
        config: raffle.promotionConfig,
        originalAmount,
        discountAmount,
      }
    : null;
```

### En la creación del objeto `Purchase`:

```typescript
const purchase = manager.create(Purchase, {
  // ... campos existentes sin cambios ...
  totalAmount: totalAmountToPersist,
  promotionSnapshot, // <-- única línea nueva
  payments: paymentsArray,
  totalPaid,
});
```

---

## Paso 4 — Script de Backfill

Para compras históricas. Sigue exactamente el mismo patrón de `fix-purchase-totals.ts`: usa `databaseConfig` + `DataSource` manual con `dotenv.config()`.

```typescript
// scripts/backfill-promotion-snapshots.ts
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import databaseConfig from '../src/config/database.config';
import { Purchase } from '../src/modules/purchases/entities/purchase.entity';
import { Raffle } from '../src/modules/raffles/entities/raffle.entity';
import { PaymentMethod } from '../src/modules/payments/entities/payment-method.entity';
import { calculatePromotionalTotal } from '../src/modules/raffles/utils/pricing.util';

dotenv.config();

const config = (databaseConfig as any)();
const dataSource = new DataSource({ ...config });

async function main() {
  try {
    console.log('Connecting to database...');
    await dataSource.initialize();

    const purchaseRepo = dataSource.getRepository(Purchase);

    const purchases = await purchaseRepo
      .createQueryBuilder('purchase')
      .leftJoinAndSelect('purchase.raffle', 'raffle')
      .leftJoinAndSelect('purchase.paymentMethod', 'paymentMethod')
      .leftJoinAndSelect('paymentMethod.currency', 'currency')
      .where('purchase.promotion_snapshot IS NULL')
      .getMany();

    console.log(`Procesando ${purchases.length} compras sin snapshot...`);
    let updated = 0;

    for (const purchase of purchases) {
      const raffle: Raffle = purchase.raffle;
      const pm: PaymentMethod = purchase.paymentMethod;

      if (!raffle?.promotionStrategy || !raffle?.promotionConfig) continue;

      const unitPrice =
        Number(raffle.ticketPrice) * Number(pm?.currency?.value ?? 1);
      const calculatedTotal = calculatePromotionalTotal(
        unitPrice,
        purchase.ticketQuantity,
        raffle.promotionStrategy,
        raffle.promotionConfig as any,
      );
      const originalAmount = Number((unitPrice * purchase.ticketQuantity).toFixed(2));
      const discountAmount = Number((originalAmount - calculatedTotal).toFixed(2));

      if (discountAmount <= 0.01) continue;

      purchase.promotionSnapshot = {
        strategy: raffle.promotionStrategy,
        config: raffle.promotionConfig,
        originalAmount,
        discountAmount,
      };

      await purchaseRepo.save(purchase);
      updated++;
    }

    console.log(`Backfill completado: ${updated} compras actualizadas.`);
  } catch (error) {
    console.error('Error en backfill:', error);
    process.exit(1);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

main();
```

Agregar al `package.json`:

```json
"db:backfill-promotion-snapshots": "ts-node scripts/backfill-promotion-snapshots.ts"
```

> **Advertencia:** Si la rifa cambió su promoción después de alguna compra histórica, el snapshot calculado puede no ser el original exacto. Es una limitación conocida del backfill.

---

## Flujo Final (Diagrama)

```
POST /api/v1/purchases
        │
        ▼
  lockAndValidateRaffle()
        │
        ▼
  calculatePromotionalTotal()   ← sin cambios
  ├─ totalAmountToPersist
  ├─ originalAmount = unitPrice * quantity
  ├─ discountAmount = originalAmount - totalAmountToPersist
  └─ promotionSnapshot = discountAmount > 0.01 ? { strategy, config, ... } : null
        │
        ▼
  manager.create(Purchase, { ..., promotionSnapshot })
        │
        ▼
  manager.save(Purchase)
```

---

## Qué NO se cambia

- `calculatePromotionalTotal()` y `pricing.util.ts` — intactos.
- DTOs de entrada (`CreatePurchaseDto`) — el snapshot es 100% computado por el backend.
- Respuestas de API — `promotionSnapshot` se expone automáticamente al retornar la entidad.
- Lógica de verificación, reconciliación, tickets, AI webhook — nada se toca.

---

## Orden de Ejecución

1. Agregar `PromotionSnapshot` y el campo `@Column` en `purchase.entity.ts`
2. Crear el archivo de migración (para historial y producción — **no ejecutar en dev**)
3. Actualizar `purchases.service.ts` (método `create`, ~5 líneas nuevas)
4. Crear `scripts/backfill-promotion-snapshots.ts` y registrar el script en `package.json`
5. Ejecutar el backfill: `npm run db:backfill-promotion-snapshots`

---

## TODO List

### Fase 1 — Modelo de datos

- [x] Abrir `src/modules/purchases/entities/purchase.entity.ts`
- [x] Agregar la interfaz `PromotionSnapshot` junto a `PaymentEntry` (al inicio del archivo, antes de los enums)
- [x] Agregar el decorador `@Column({ type: 'jsonb', nullable: true, name: 'promotion_snapshot' })` y el campo `promotionSnapshot: PromotionSnapshot | null` dentro de la clase `Purchase`, después del campo `totalAmount`
- [ ] Verificar que el servidor arranca sin errores (manual)
- [ ] Confirmar que la columna `promotion_snapshot` existe en la tabla `purchase` en la DB (manual)

### Fase 2 — Migración

- [x] Crear el archivo `src/migrations/1770600000000-AddPromotionSnapshotToPurchase.ts`
- [x] Implementar el método `up` con `queryRunner.addColumn('purchase', new TableColumn({ name: 'promotion_snapshot', type: 'jsonb', isNullable: true }))`
- [x] Implementar el método `down` con `queryRunner.dropColumn('purchase', 'promotion_snapshot')`
- [x] Agregar `TableColumn` al import de `typeorm`
- [x] Verificar que el nombre de la clase coincide con el timestamp: `AddPromotionSnapshotToPurchase1770600000000`

### Fase 3 — Servicio

- [x] Abrir `src/modules/purchases/purchases.service.ts`
- [x] Añadir `PromotionSnapshot` al import desde `./entities/purchase.entity`
- [x] Localizar el bloque de cálculo del total en `create()` (después de la validación de `totalDiff`, línea ~121)
- [x] Calcular `originalAmount` con `Number((unitPriceInPaymentCurrency * createDto.ticket_quantity).toFixed(2))`
- [x] Calcular `discountAmount` con `Number((originalAmount - totalAmountToPersist).toFixed(2))`
- [x] Construir `promotionSnapshot`: objeto si `discountAmount > 0.01 && raffle.promotionStrategy`, `null` en caso contrario
- [x] Agregar `promotionSnapshot` al objeto de `manager.create(Purchase, { ... })`

### Fase 4 — Script de Backfill

- [x] Crear el archivo `scripts/backfill-promotion-snapshots.ts`
- [x] Configurar `dotenv.config()` y el `DataSource` usando `AppDataSource` de `typeorm.datasource.ts` (type-safe, sin `as any`)
- [x] Implementar la query con `createQueryBuilder` filtrando `WHERE purchase.promotion_snapshot IS NULL` con las relaciones `raffle`, `paymentMethod`, `paymentMethod.currency`
- [x] Implementar el loop: saltar si la rifa no tiene `promotionStrategy` o `promotionConfig`
- [x] Calcular `unitPrice`, `calculatedTotal`, `originalAmount`, `discountAmount` por cada compra
- [x] Saltar si `discountAmount <= 0.01` (compra sin descuento efectivo)
- [x] Asignar `purchase.promotionSnapshot` y guardar con `purchaseRepo.save(purchase)`
- [x] Agregar logging de progreso y bloque `try/catch/finally` con `AppDataSource.destroy()`
- [x] Agregar el script al `package.json`: `"db:backfill-promotion-snapshots": "ts-node scripts/backfill-promotion-snapshots.ts"`

### Fase 5 — Verificación (manual, requiere servidor + DB)

- [ ] Reiniciar el servidor en dev y crear una compra en una rifa con promoción activa
- [ ] Verificar en DB que `promotion_snapshot` se guardó con los campos correctos (`strategy`, `config`, `originalAmount`, `discountAmount`)
- [ ] Crear una compra en una rifa sin promoción y verificar que `promotion_snapshot` es `NULL`
- [ ] Ejecutar `npm run db:backfill-promotion-snapshots` y verificar el conteo de compras actualizadas
- [ ] Spot-check manual: tomar una compra histórica actualizada y validar que `discountAmount` es coherente con `totalAmount` y `originalAmount`
