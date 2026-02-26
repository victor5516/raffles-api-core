# Investigación Profunda: `GET /api/v1/dashboard/raffles/:raffleId/stats`

## 1. Definición del Endpoint

**Archivo:** `src/modules/dashboard/dashboard.controller.ts` (línea 55)

```
GET /api/v1/dashboard/raffles/:raffleId/stats
```

- **Autorización:** `@Auth(AdminRole.SUPER_ADMIN)` — Solo admins con rol `SUPER_ADMIN` pueden acceder. Aplica `JwtAuthGuard` + `RolesGuard`.
- **Respuesta:** `RaffleStatsResponseDto`
- **Error 404:** si la rifa no existe

---

## 2. Flujo General del Handler

`dashboard.controller.ts:73` → `dashboard.service.ts:155`

El servicio ejecuta **10 queries en paralelo** via `Promise.all` (líneas 161–183), y luego hace un cálculo síncrono + 1 query adicional asíncrona:

```typescript
const [
  participantsCount,          // distinct customers con compras VERIFIED
  ticketsSold,                // SUM(ticketQuantity) VERIFIED
  totalPurchases,             // COUNT compras VERIFIED
  amountCollectedByCurrency,  // SUM(totalPaid) agrupado por moneda
  ticketsSoldByDay,           // serie diaria para gráficas
  averageTimeBetweenSalesMinutes,
  sellDuration,
  topLocations,
  participantsWithoutLocation,
  aiAuditStats,
] = await Promise.all([...]);

// Síncrono — líneas 185–190
const salesPercentage = ...;
const amountCollected = ...;

// Asíncrono extra — línea 192
const amountCollectedInUsd = await this.computeRaffleAmountInUsd(...);
```

---

## 3. Cálculo de `salesPercentage` (Porcentaje de Ventas)

### Fórmula (línea 185–186)

```typescript
const salesPercentage =
  raffle.totalTickets > 0 ? (ticketsSold / raffle.totalTickets) * 100 : 0;
```

### Fuente de datos

**`ticketsSold`** — viene de `getRaffleTicketsSold()` (línea 284):

```sql
SELECT COALESCE(SUM(purchase.ticket_quantity), 0) AS sum
FROM purchase
WHERE purchase.raffle_id = $raffleId
  AND purchase.status = 'verified'
```

- Solo cuenta compras en estado `VERIFIED`.
- `ticketQuantity` es columna entera en la entidad `Purchase`.
- El resultado se convierte con `Number(raw?.sum ?? 0)` — necesario porque node-postgres devuelve `BIGINT`/`NUMERIC` como string.

**`raffle.totalTickets`** — campo `total_tickets` de la entidad `Raffle`, tipo `integer` en la DB, leído con `findOne` al inicio del handler.

### Problemas de punto flotante

**Problema: no se aplica redondeo.**

Dado que ambos operandos son enteros, la división en JavaScript (IEEE 754 double) puede producir decimales no terminantes en binario:

```
ticketsSold = 1000, totalTickets = 3000  → 33.33333333333333...4
ticketsSold = 1, totalTickets = 3        → 33.33333333333333...4
ticketsSold = 2, totalTickets = 3        → 66.66666666666667  (redondeo hacia arriba)
```

El valor enviado al cliente tiene todos los decimales sin truncar. No hay `toFixed()` ni `Math.round()`. Comparar con `averageTicketsPerPurchase` (línea 203), donde sí se aplica `.toFixed(2)`.

---

## 4. Cálculo de `amountCollected` (Suma Bruta Multi-moneda)

### Cómo se obtiene la data: `getRaffleCollectedAmountByCurrency()` (línea 310)

Ejecuta dos queries en paralelo:

1. **Todas las monedas** configuradas en la tabla `currency` (ordenadas por nombre).
2. **Montos por moneda** de compras verificadas:

```sql
SELECT payment_method.currency_id AS "currencyId",
       COALESCE(SUM(purchase.total_paid), 0) AS sum
FROM purchase
INNER JOIN payment_method ON purchase.payment_method_id = payment_method.uid
WHERE purchase.raffle_id = $raffleId
  AND purchase.status = 'verified'
GROUP BY payment_method.currency_id
```

Luego construye un `Map<currencyId, amount>` con los resultados y mapea **todas** las monedas, poniendo `0` en las que no tienen compras (línea 334–339). El resultado es un array con todas las monedas configuradas en el sistema.

### Cálculo de `amountCollected` (línea 187–190)

```typescript
const amountCollected = amountCollectedByCurrency.reduce(
  (sum, row) => sum + row.amountCollected,
  0,
);
```

**Semántica:** suma cruda de montos en distintas monedas mezcladas. Ej: si hay 1000 VES y 50 USD, `amountCollected = 1050`. **No es una suma en USD**, es la suma nominal de todos los `totalPaid` independientemente de la moneda. Su utilidad práctica es limitada, pero se reporta como dato adicional.

### Campo `totalPaid` vs `totalAmount`

- `totalPaid` (`numeric(10,2)`) — lo que el cliente efectivamente pagó.
- `totalAmount` (`numeric(10,2)`) — lo que se esperaba que pagara.
- El endpoint usa **`totalPaid`** (correcto para reflejar dinero real recibido, confirmado en el DTO: "Monto recogido usando totalPaid").

### Problemas de punto flotante

**Problema: acumulación de errores en `reduce`.**

`row.amountCollected` viene de `Number(row.sum ?? 0)`. PostgreSQL devuelve `NUMERIC` como string via node-postgres. Al pasar por `Number()`, el valor pasa a IEEE 754 double. La suma con `+` en JavaScript acumula errores:

```
100.10 + 200.20 = 300.29999999999998  (en JS, no 300.30)
```

Para valores monetarios con 2 decimales provenientes de una columna `numeric(10,2)`, el error típico es del orden `1e-14` a `1e-12`, lo que generalmente es invisible en display, pero **no es exacto** y puede causar problemas al comparar o redondear.

---

## 5. Cálculo de `amountCollectedInUsd` (Total en Dólares)

Este es el cálculo más complejo y el más propenso a errores de punto flotante.

### Método: `computeRaffleAmountInUsd()` (línea 221)

```typescript
private async computeRaffleAmountInUsd(
  amountCollectedByCurrency: RaffleAmountByCurrency[],
): Promise<number> {
  const currencies = await this.currencyRepository.find({ order: { name: 'ASC' } });

  const currencyMap = new Map<string, Currency>(
    currencies.map((currency) => [currency.uid, currency]),
  );

  const amountCollectedInUsd = amountCollectedByCurrency.reduce(
    (sumUsd, row) => {
      const currency = currencyMap.get(row.currencyId);
      if (!currency) return sumUsd;

      const value = Number(currency.value ?? 0);   // tasa de cambio
      const rate = value > 0 ? value : 1;
      const amountInUsd = row.amountCollected / rate;  // conversión

      return sumUsd + amountInUsd;
    },
    0,
  );

  return amountCollectedInUsd;
}
```

### Modelo de conversión

La entidad `Currency` tiene:

```typescript
@Column({ type: 'decimal' })
value: number;
```

`value` representa **cuántas unidades de la moneda equivalen a 1 USD**. Ejemplos:
- USD: `value = 1` → `amountInUsd = amount / 1 = amount` (sin cambio)
- VES: `value = 36.5` (hipotético) → `amountInUsd = amount / 36.5`
- COP: `value = 4200` → `amountInUsd = amount / 4200`

**Fórmula por moneda:**
```
amountInUsd = amountCollected / currency.value
```

**Total:**
```
amountCollectedInUsd = Σ (amountCollected_i / currency.value_i)
```

### Comportamiento defensivo para `value <= 0`

Línea 238: `const rate = value > 0 ? value : 1;`

Si `currency.value` es `0` o negativo (dato corrupto), la tasa fallback es `1`, lo que trata la moneda como si fuera 1:1 con USD. Para monedas con tasas altísimas (VES/USD puede ser millones a uno), esto inflaría el total en USD enormemente.

### Problemas de punto flotante

**Problema 1: `currency.value` es `decimal` sin precisión/escala definida.**

```typescript
@Column({ type: 'decimal' })  // sin precision ni scale
value: number;
```

En PostgreSQL, `DECIMAL` sin argumentos equivale a "precisión arbitraria". node-postgres devuelve esta columna como string. Al aplicar `Number(currency.value)`, el valor pasa a IEEE 754 double (64-bit), que tiene ~15-17 dígitos significativos. Para tasas de cambio como `36500.50`, la representación en double podría no ser exacta.

**Problema 2: División produce fracciones binarias no terminantes.**

Para tasas de cambio comunes (e.g., `36.5`, `4200`, `1.08`), la división en IEEE 754 no es exacta:

```javascript
1000 / 36.5  // = 27.397260273972602... (OK para display)
1000 / 3     // = 333.3333333333333...
```

**Problema 3: Acumulación en `reduce` sin redondeo intermedio.**

```typescript
return sumUsd + amountInUsd;
```

Se suman resultados de divisiones potencialmente inexactas. Los errores se acumulan con cada moneda adicional. Para 5 monedas con tasas irregulares, el error final puede ser del orden `1e-10` a `1e-8`. Invisible en display pero no exacto.

**Problema 4: No hay redondeo al final del método.**

`amountCollectedInUsd` se devuelve directamente sin `toFixed()` ni rounding. El cliente recibe valores como `10.249999999998427` en lugar de `10.25`.

---

## 6. Doble Fetch de Currencies (Problema de Performance)

`computeRaffleAmountInUsd` (línea 224) hace:
```typescript
const currencies = await this.currencyRepository.find({ order: { name: 'ASC' } });
```

Pero `getRaffleCollectedAmountByCurrency` (línea 313) ya hizo:
```typescript
this.currencyRepository.find({ order: { name: 'ASC' } }),
```

**Resultado: las monedas se consultan DOS VECES** por cada llamada al endpoint. La segunda llamada es innecesaria; el array `amountCollectedByCurrency` ya contiene `currencyName` y `currencySymbol` pero no el `value` de la tasa de cambio. La solución más directa sería pasar la lista de `Currency` completa desde `getRaffleCollectedAmountByCurrency` hacia `computeRaffleAmountInUsd`.

---

## 7. Resumen de Todas las Operaciones Aritméticas en Punto Flotante

| Campo | Fórmula | Redondeo | Riesgo FP |
|---|---|---|---|
| `salesPercentage` | `(ticketsSold / totalTickets) * 100` | ❌ Ninguno | Medio — decimales largos en divisiones como 1/3 |
| `amountCollected` | `Σ amountCollected_i` (reduce) | ❌ Ninguno | Bajo — suma simple, error ~1e-14 |
| `amountCollectedInUsd` | `Σ (amount_i / rate_i)` (reduce) | ❌ Ninguno | Alto — división + acumulación sin redondeo |
| `averageTicketsPerPurchase` | `ticketsSold / totalPurchases` | ✅ `.toFixed(2)` | Nulo — redondeo correcto |
| `averageTimeBetweenSalesMinutes` | `totalDiffMs / intervals / 60000` | ✅ `.toFixed(2)` | Nulo — redondeo correcto |
| `durationInHours` | `durationMs / 3600000` | ❌ Ninguno | Bajo — solo para display |
| `durationInDays` | `durationInHours / 24` | ❌ Ninguno | Bajo — solo para display |

---

## 8. Queries SQL Ejecutadas (Resumen)

Todas las queries filtran por `purchase.status = 'verified'`.

| Método | Query | Agrupación |
|---|---|---|
| `getRaffleParticipants` | `COUNT(DISTINCT customer_id)` | — |
| `getRaffleTicketsSold` | `COALESCE(SUM(ticket_quantity), 0)` | — |
| `getRaffleTotalPurchases` | `COUNT(uid)` | — |
| `getRaffleCollectedAmountByCurrency` | `COALESCE(SUM(total_paid), 0)` | `currency_id` |
| `getRaffleTicketsSoldByDay` | `ticket_quantity + submitted_at` | Post-procesado en JS (timezone: America/Caracas) |
| `getAverageTimeBetweenSalesMinutes` | `COALESCE(verified_at, submitted_at)` | Post-procesado en JS |
| `getRaffleSellDuration` | `MAX(COALESCE(verified_at, submitted_at))` | — |
| `getTopLocationsByRaffle` | `SUM(ticket_quantity)` | `customer.location->>'state'` |
| `getRaffleParticipantsWithoutLocation` | `COUNT(DISTINCT customer_id)` | — |
| `getRaffleAiAuditStats` | 5 `COUNT(*) FILTER (WHERE ...)` en una sola query | — |

---

## 9. Diagrama de Flujo Completo

```
GET /api/v1/dashboard/raffles/:raffleId/stats
│
├─ Buscar Raffle por uid → 404 si no existe
│
├─ Promise.all (10 queries paralelas a PostgreSQL)
│   ├─ COUNT DISTINCT customers (VERIFIED)
│   ├─ SUM ticket_quantity (VERIFIED) → ticketsSold
│   ├─ COUNT purchases (VERIFIED) → totalPurchases
│   ├─ [currencies + SUM(total_paid) GROUP BY currency_id] → amountCollectedByCurrency
│   ├─ SELECT submitted_at, ticket_quantity (VERIFIED, ordenado ASC) → post-procesar por día
│   ├─ SELECT COALESCE(verified_at, submitted_at) (VERIFIED, ASC) → intervalos de tiempo
│   ├─ MAX(COALESCE(verified_at, submitted_at)) (VERIFIED) → sellDuration
│   ├─ SUM(ticket_quantity) GROUP BY state (VERIFIED, top 5)
│   ├─ COUNT DISTINCT customers WHERE state IS NULL (VERIFIED)
│   └─ 5x COUNT FILTER por condiciones AI (VERIFIED + otros)
│
├─ Síncrono:
│   ├─ salesPercentage = (ticketsSold / raffle.totalTickets) * 100   [⚠ sin redondeo]
│   └─ amountCollected = Σ row.amountCollected                        [⚠ FP acumulación]
│
├─ Asíncrono (1 query extra):
│   └─ computeRaffleAmountInUsd():
│       ├─ currencies.find() ← [⚠ segunda consulta a currencies, redundante]
│       └─ Σ (amountCollected_i / currency.value_i)                  [⚠⚠ FP división + acumulación, sin redondeo]
│
└─ Retorna RaffleStatsResponseDto
```

---

## 10. Conclusiones y Riesgos

### Alto impacto
- **`amountCollectedInUsd` sin redondeo final:** Para mostrar en frontend, el valor puede tener 12+ decimales. Si se usa en comparaciones o lógica de negocio, puede dar resultados incorrectos. Solución: `Math.round(amountCollectedInUsd * 100) / 100` o equivalente.

### Impacto medio
- **`salesPercentage` sin redondeo:** Visualmente puede mostrar `33.33333333333334%`. Solución: `parseFloat(salesPercentage.toFixed(2))`.
- **`currency.value` sin `precision`/`scale`:** La columna debería tener precision definida para controlar la exactitud de las tasas de cambio en la DB.

### Impacto bajo
- **`amountCollected` multi-moneda:** El error de acumulación FP es despreciable para valores monetarios razonables (~`1e-12`).
- **Double fetch de currencies:** Ineficiencia de performance, no un bug funcional.

### Sin impacto
- **`averageTicketsPerPurchase`** y **`averageTimeBetweenSalesMinutes`** usan `.toFixed(2)` correctamente.
- El manejo de `NULL` con `COALESCE` y `?? 0` en todos los raw queries es correcto.
- El uso de `Number()` explícito en resultados raw es necesario y correcto (node-postgres devuelve `NUMERIC` como string).
