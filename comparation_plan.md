# Plan de Mejoras: Conciliación Bancaria para Pagos en Bs

## Objetivo

Llevar el índice de aciertos de la conciliación al **100% para pagos en Bolívares**. Los últimos 7 caracteres de la referencia son el identificador clave que siempre coincide entre el estado de cuenta del banco y lo registrado en DB.

## Alcance

**Un solo archivo modificado**: `src/modules/purchases/services/reconciliation.service.ts`

No se necesitan migraciones, cambios de entidades, nuevos módulos, ni cambios en el DTO de respuesta. Todos los cambios son internos al servicio.

---

## Causa raíz resumida

La lógica de matching ya es correcta en concepto (sufijo de 7 chars). El problema está en que los datos que se le pasan al comparador son incompletos o incorrectos:

| Causa | Frecuencia | Impacto |
|-------|-----------|---------|
| Early return con ref AI incorrecta (OCR malo) ignora `payments[]` y `bankReference` | Alta | Crítico |
| Campo `bankReference` (legacy) nunca consultado | Media | Alto |
| Referencia del banco en `description` cuando `reference` llega vacío | Media | Alto |
| Tolerancia de monto ±0.01 demasiado estricta para redondeos de Bs | Baja | Medio |

---

## Cambio 1 — `extractPurchaseReferences()`: acumular todos los candidatos

### Problema

El `return` temprano hace que si existe `aiAnalysisResult`, **solo** se use esa referencia. Si el OCR leyó un dígito mal, no hay segunda oportunidad.

```typescript
// ACTUAL: early return — ignora payments[] y bankReference
if (purchase.aiAnalysisResult?.data?.reference) {
  refs.push({ reference: aiRef, amount: aiAmount });
  return refs; // ← TODO lo demás se ignora
}
```

### Solución

Eliminar el early return y acumular **todos** los candidatos en orden de prioridad. Usar un `Set` de referencias normalizadas para evitar duplicados.

```typescript
// NUEVO: collectAll — nunca hace return temprano
private extractPurchaseReferences(purchase: Purchase): Array<{
  reference: string;
  amount: number;
}> {
  const refs: Array<{ reference: string; amount: number }> = [];
  const seen = new Set<string>();

  const defaultAmount = Number(purchase.totalPaid ?? purchase.totalAmount ?? 0);

  const tryAdd = (ref: string | null | undefined, amount: number) => {
    if (!ref) return;
    const norm = this.normalizeRef(ref);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    refs.push({ reference: String(ref), amount });
  };

  // Candidato 1: ai_analysis_result (OCR del comprobante)
  if (purchase.aiAnalysisResult?.data?.reference) {
    const aiAmount = Number(
      purchase.aiAnalysisResult.data.amount ??
      purchase.totalPaid ??
      purchase.totalAmount ??
      0,
    );
    tryAdd(String(purchase.aiAnalysisResult.data.reference), aiAmount);
  }

  // Candidato 2: payments[] (referencia ingresada manualmente / multi-pago)
  if (Array.isArray(purchase.payments)) {
    for (const payment of purchase.payments) {
      if (payment.reference) {
        tryAdd(String(payment.reference), Number(payment.amount ?? defaultAmount));
      }
    }
  }

  // Candidato 3: bankReference legacy (columna bank_reference)
  if (purchase.bankReference) {
    tryAdd(String(purchase.bankReference), defaultAmount);
  }

  return refs;
}
```

**Resultado**: una compra ahora puede exponer hasta 3 referencias candidatas. Si la IA OCR leyó mal un dígito, el sistema intentará también con la referencia de `payments[]` o `bankReference` antes de descartarla.

---

## Cambio 2 — Fallback de referencia desde `tx.description`

### Problema

Cuando Gemini no extrae referencia explícita del estado de cuenta (devuelve `reference: ""`), la transacción bancaria se descarta inmediatamente sin intentar nada:

```typescript
// ACTUAL: descarta si no hay referencia extraída
const normBankRef = this.normalizeRef(tx.reference);
if (!normBankRef) {
  unmatchedBank.push(tx);
  continue; // ← fin, no hay fallback
}
```

Las referencias venezolanas suelen aparecer en el campo descripción del estado de cuenta como secuencias numéricas largas (ej.: `"PAGO MOVIL 00510 1282438 BANCO MERCANTIL"`).

### Solución

Agregar un método privado que extrae la secuencia numérica más larga (≥7 dígitos) de la descripción, y usarlo como fallback antes de descartar la transacción.

**Nuevo método privado** (agregar antes de `matchTransactions`):

```typescript
/**
 * Extrae la secuencia numérica continua más larga de una descripción bancaria.
 * Útil como fallback cuando Gemini no pudo identificar el campo "reference" explícito.
 * Solo se considera válido si tiene al menos MIN_SUFFIX_MATCH_LENGTH dígitos.
 * Ejemplo: "PAGO MOVIL 1282438 ORIGEN BANCAMIGA" → "1282438"
 */
private extractRefFromDescription(description: string): string {
  if (!description) return '';
  const matches = description.match(/\d{7,}/g);
  if (!matches || matches.length === 0) return '';
  // Devolver la secuencia más larga (más probable que sea la referencia real)
  return matches.reduce(
    (longest, current) => (current.length > longest.length ? current : longest),
    '',
  );
}
```

**Modificar el bloque de validación dentro de `matchTransactions()`:**

```typescript
// ANTES:
const normBankRef = this.normalizeRef(tx.reference);
if (!normBankRef) {
  unmatchedBank.push(tx);
  continue;
}

// DESPUÉS:
const bankRefRaw =
  tx.reference || this.extractRefFromDescription(tx.description);
const normBankRef = this.normalizeRef(bankRefRaw);
if (!normBankRef) {
  unmatchedBank.push(tx);
  continue;
}
```

**También actualizar `matched.push()` más abajo en el mismo método** (línea 322 del código actual):

```typescript
// ANTES:
matched.push({
  purchaseId: purchase.uid,
  bankRef: tx.reference,   // ← vacío si la ref vino de description
  amount: bankAmount,
  diff: signedDiff,
});

// DESPUÉS:
matched.push({
  purchaseId: purchase.uid,
  bankRef: bankRefRaw,     // ← usa la referencia real usada para el match
  amount: bankAmount,
  diff: signedDiff,
});
```

**Resultado**: transacciones bancarias cuya referencia estaba embebida en la descripción ahora tienen una oportunidad de hacer match en lugar de caer directamente en `unmatchedBank`, y el resultado devuelto al frontend refleja correctamente qué referencia fue usada.

---

## Cambio 3 — Tolerancia de monto: extraer a constante y ampliar a ±1.00

### Problema

La tolerancia de `0.01` está hardcodeada inline y es demasiado estricta para Bs. Pequeñas diferencias de redondeo bancario (comisiones mínimas, truncamiento de decimales del banco receptor) rompen el match aunque la referencia sea perfecta.

```typescript
// ACTUAL: hardcodeado, muy estricto
const amountDiff = Math.abs(bankAmount - purchaseAmount);
const amountMatches = amountDiff <= 0.01;
```

### Solución

Extraer a una constante de clase (`AMOUNT_TOLERANCE`) y cambiar el valor a `1.00`. Esto cubre redondeos bancarios sin riesgo de falsos positivos (las referencias siguen siendo el filtro principal).

```typescript
// Constante nueva a nivel de clase (junto a MIN_SUFFIX_MATCH_LENGTH):
private readonly AMOUNT_TOLERANCE = 1.00;

// Uso en matchTransactions() — mismo lugar, solo cambia el literal:
const amountDiff = Math.abs(bankAmount - purchaseAmount);
const amountMatches = amountDiff <= this.AMOUNT_TOLERANCE;
```

**¿Por qué ±1.00 es seguro?**: el filtro de referencia (sufijo 7 chars) es muy selectivo. Dos transacciones distintas raramente comparten los últimos 7 dígitos de referencia Y además están dentro de ±1.00 Bs de diferencia. El riesgo de falso positivo es mínimo.

---

## Vista final del servicio con los 3 cambios aplicados

A continuación el diff conceptual de todos los cambios sobre `reconciliation.service.ts`:

```diff
+ private readonly AMOUNT_TOLERANCE = 1.00;
  private readonly MIN_SUFFIX_MATCH_LENGTH = 7;

+ private extractRefFromDescription(description: string): string {
+   if (!description) return '';
+   const matches = description.match(/\d{7,}/g);
+   if (!matches || matches.length === 0) return '';
+   return matches.reduce(
+     (longest, current) => (current.length > longest.length ? current : longest),
+     '',
+   );
+ }

  private extractPurchaseReferences(purchase: Purchase): Array<{ reference: string; amount: number }> {
    const refs: Array<{ reference: string; amount: number }> = [];
+   const seen = new Set<string>();
+   const defaultAmount = Number(purchase.totalPaid ?? purchase.totalAmount ?? 0);
+
+   const tryAdd = (ref: string | null | undefined, amount: number) => {
+     if (!ref) return;
+     const norm = this.normalizeRef(ref);
+     if (!norm || seen.has(norm)) return;
+     seen.add(norm);
+     refs.push({ reference: String(ref), amount });
+   };

    // Candidato 1: ai_analysis_result
    if (purchase.aiAnalysisResult?.data?.reference) {
      const aiAmount = Number(purchase.aiAnalysisResult.data.amount ?? purchase.totalPaid ?? purchase.totalAmount ?? 0);
-     refs.push({ reference: aiRef, amount: aiAmount });
-     return refs;  // ← early return eliminado
+     tryAdd(String(purchase.aiAnalysisResult.data.reference), aiAmount);
    }

    // Candidato 2: payments[]
    if (Array.isArray(purchase.payments)) {
      for (const payment of purchase.payments) {
-       if (payment.reference && payment.amount) {
-         refs.push({ reference: String(payment.reference), amount: Number(payment.amount) });
-       }
+       if (payment.reference) {
+         tryAdd(String(payment.reference), Number(payment.amount ?? defaultAmount));
+       }
      }
    }

+   // Candidato 3: bankReference (campo legacy)
+   if (purchase.bankReference) {
+     tryAdd(String(purchase.bankReference), defaultAmount);
+   }

    return refs;
  }

  // Dentro de matchTransactions():
- const normBankRef = this.normalizeRef(tx.reference);
+ const bankRefRaw = tx.reference || this.extractRefFromDescription(tx.description);
+ const normBankRef = this.normalizeRef(bankRefRaw);
  if (!normBankRef) {
    unmatchedBank.push(tx);
    continue;
  }

- const amountMatches = amountDiff <= 0.01;
+ const amountMatches = amountDiff <= this.AMOUNT_TOLERANCE;

  // En matched.push() (línea 322):
- bankRef: tx.reference,
+ bankRef: bankRefRaw,

  // Corregir comentario obsoleto (línea 310):
- // Comparar referencias con matching parcial (mínimo 4 caracteres)
+ // Comparar referencias por sufijo (mínimo MIN_SUFFIX_MATCH_LENGTH = 7 caracteres)
```

---

## Orden de implementación sugerido

| Paso | Cambio | Riesgo |
|------|--------|--------|
| 1 | Extraer `AMOUNT_TOLERANCE = 1.00` como constante | Mínimo — solo refactor + pequeño aumento de tolerancia |
| 2 | Reescribir `extractPurchaseReferences()` sin early return | Bajo — amplía candidatos, nunca reduce los existentes |
| 3 | Agregar `extractRefFromDescription()` + fallback en `matchTransactions()` | Bajo — solo actúa cuando `tx.reference` está vacío |

---

## Casos de prueba mentales para validar

| Escenario | Antes | Después |
|-----------|-------|---------|
| OCR guardó ref `"1282439"` pero user ingresó `"1282438"` en `payments[]` | ❌ no match | ✅ candidato de payments[] hace match |
| Compra vieja con solo `bankReference = "1282438"` y sin AI ni payments | ❌ no match (skippeada) | ✅ candidato legacy hace match |
| Estado de cuenta sin columna referencia, ref en descripción `"PAGO MOVIL 1282438 ORIGEN"` | ❌ no match (ref vacía) | ✅ extraída del description |
| Monto DB `150.00`, banco `150.05` (redondeo Bs) | ❌ diff=0.05 > 0.01 | ✅ diff=0.05 ≤ 1.00 |
| Dos pagos distintos, refs diferentes, montos similares | ✅ no confusión | ✅ sin cambio (ref sigue siendo filtro) |

---

## TODO List

### Fase 1 — Constante de tolerancia de monto

- [x] **1.1** Agregar la constante `private readonly AMOUNT_TOLERANCE = 1.00;` a nivel de clase, inmediatamente encima de `MIN_SUFFIX_MATCH_LENGTH` (línea 195)
- [x] **1.2** Reemplazar el literal `0.01` en línea 308 por `this.AMOUNT_TOLERANCE`
- [x] **1.3** Verificar que el build TypeScript compila sin errores (`npm run build`)

---

### Fase 2 — Reescribir `extractPurchaseReferences()`

- [x] **2.1** Eliminar el `return refs;` del early return (línea 235: `// Si tiene AI result, solo usamos ese`)
- [x] **2.2** Agregar `const seen = new Set<string>();` al inicio del cuerpo de la función
- [x] **2.3** Agregar `const defaultAmount = Number(purchase.totalPaid ?? purchase.totalAmount ?? 0);`
- [x] **2.4** Agregar la closure `tryAdd` inmediatamente debajo de `defaultAmount`
- [x] **2.5** Reemplazar el `refs.push({ reference: aiRef, amount: ... })` del bloque AI por `tryAdd(...)` con cast tipado para evitar `no-unsafe-member-access`
- [x] **2.6** En el bloque `payments[]`: cambiar la condición de `payment.reference && payment.amount` a solo `payment.reference`, y reemplazar el `refs.push(...)` por `tryAdd(String(payment.reference), Number(payment.amount ?? defaultAmount))`
- [x] **2.7** Agregar bloque del Candidato 3 al final (antes del `return refs`):
  ```typescript
  if (purchase.bankReference) {
    tryAdd(String(purchase.bankReference), defaultAmount);
  }
  ```
- [x] **2.8** Verificar que el build TypeScript compila sin errores (`npm run build`)

---

### Fase 3 — Fallback de referencia desde `tx.description`

- [x] **3.1** Agregar el método privado `extractRefFromDescription(description: string): string` antes de `matchTransactions()`
- [x] **3.2** En `matchTransactions()`, reemplazar `const normBankRef = this.normalizeRef(tx.reference);` por `bankRefRaw` con fallback a description
- [x] **3.3** En `matched.push()`, cambiar `bankRef: tx.reference` por `bankRef: bankRefRaw`
- [x] **3.4** Verificar que el build TypeScript compila sin errores (`npm run build`)

---

### Fase 4 — Limpieza de comentario obsoleto

- [x] **4.1** En línea 310, corregir el comentario:
  - De: `// Comparar referencias con matching parcial (mínimo 4 caracteres)`
  - A: `// Comparar referencias por sufijo (mínimo MIN_SUFFIX_MATCH_LENGTH = 7 caracteres)`

---

### Fase 5 — Validación final

- [x] **5.1** Ejecutar `npm run build` completo y confirmar cero errores TypeScript
- [x] **5.2** Ejecutar `npm run lint` y confirmar cero errores/warnings en el archivo modificado
- [ ] **5.3** Verificar manualmente los 5 escenarios de la tabla de casos de prueba mentales usando la lógica en la cabeza o con datos reales de prueba
- [ ] **5.4** Hacer una conciliación de prueba con un estado de cuenta real de Bs y confirmar que el número de matches aumenta respecto al comportamiento anterior
