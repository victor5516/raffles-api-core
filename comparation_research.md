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

### Causa 4: Campo `bankReference` legacy ignorado

Compras antiguas pueden tener la referencia solo en `purchase.bankReference` (campo legacy). Esta columna **nunca se consulta** en el proceso de reconciliación. Si `aiAnalysisResult` es null Y `payments[]` está vacío, `extractPurchaseReferences()` devuelve `[]` y la compra es skipeada completamente.

### Causa 5: Referencia bancaria no extraída por Gemini

Si el estado de cuenta tiene la referencia en un formato inusual o embebida solo en la descripción, Gemini puede devolver `reference: ""` para algunas transacciones. En ese caso, la transacción cae directamente a `unmatchedBank`:

```typescript
const normBankRef = this.normalizeRef(tx.reference);
if (!normBankRef) {
  unmatchedBank.push(tx);
  continue; // ← salta sin intentar nada más
}
```

No hay ningún intento de extraer la referencia desde `tx.description` como fallback.

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

### Mejora 1: Prioridad de referencia — usar `payments[]` como fallback cuando AI existe

En lugar del early return, cuando `aiAnalysisResult` existe pero también hay `payments[]`, agregar las referencias de `payments[]` como candidatos adicionales:

```
ACTUAL:  AI ref → return
PROPUESTO: AI ref + payments[].reference + bankReference (todos como candidatos)
```

Así si la IA leyó mal, todavía se intenta con la referencia que el usuario ingresó manualmente.

### Mejora 2: Incluir el campo `bankReference` (legacy) como candidato

Agregar `purchase.bankReference` al array de referencias candidatas si no está vacío, con el `totalPaid` como monto asociado.

### Mejora 3: Separar matching de referencia y monto para Bs

Para pagos en Bs, el monto puede tener variaciones mayores a ±0.01 debido a redondeos bancarios. Se podría:
- Ampliar la tolerancia a ±1.00 Bs para el método de pago de tipo Bs
- O: hacer primero match solo por referencia (sufijo 7 chars) y luego validar el monto con tolerancia configurable por `paymentMethod`

### Mejora 4: Fallback de descripción bancaria

Cuando Gemini no extrae referencia explícita (`tx.reference === ""`), intentar buscar secuencias numéricas de ≥7 dígitos dentro de `tx.description` antes de descartar la transacción.

### Mejora 5: Match solo por referencia cuando monto es inconsistente

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
| `services/bank-statement-parser.service.ts` | Parseo del archivo bancario via Gemini AI |
| `dto/reconciliation.dto.ts` | Tipos `BankTransaction`, `ReconciliationResult` |
| `entities/purchase.entity.ts` | Entidad Purchase con campos `aiAnalysisResult`, `payments[]`, `bankReference` |
| `purchases.controller.ts` | Endpoint `POST /api/v1/purchases/reconcile` |
