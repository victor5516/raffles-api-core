# Plan de Implementación: Mejoras al BankStatementParserService

## Objetivo

Resolver los 6 problemas identificados en `ai_parser_research.md`. El más crítico es la pérdida silenciosa de transacciones cuando el estado de cuenta supera ~160 filas, causada por el límite de 8,192 tokens de salida de Gemini.

## Alcance

**Un solo archivo modificado**: `src/modules/purchases/services/bank-statement-parser.service.ts`

No se necesitan migraciones, cambios de entidades, nuevos módulos ni cambios en DTOs.

---

## Causa raíz por prioridad

| # | Problema | Severidad | Solución |
|---|----------|-----------|----------|
| 1 | Sin chunking — 400 tx → solo ~155 llegan | Crítico | Fase 2: split CSV/Excel en chunks de 100 filas |
| 2 | `finishReason` nunca revisado — pérdida silenciosa | Crítico | Fase 1: leer `candidates[0].finishReason` y loggear warn |
| 3 | `parseAmount` falla con `150.000,00` | Alto | Fase 1: heurística `lastComma > lastDot` |
| 4 | `safeJsonParse` no cubre `Unexpected end of JSON input` | Alto | Fase 1: ampliar condición del recovery |
| 5 | `eachCell` sin `includeEmpty` — columnas desalineadas en Excel | Medio | Fase 1: pasar `{ includeEmpty: true }` |
| 6 | Error swallowing total sin contexto en logs | Medio | Fase 1: `this.logger.error` antes de rethrow |

---

## Fase 1 — Correcciones locales (no cambian arquitectura)

### 1.0 — Agregar `Logger` a la clase ⚠️ PREREQUISITO DE TODAS LAS DEMÁS TAREAS

`BankStatementParserService` no tiene Logger. El plan usa `this.logger` en 4 lugares. Sin este paso el código no compila.

```typescript
// ANTES — import (línea 1):
import { Injectable, InternalServerErrorException } from '@nestjs/common';

// DESPUÉS:
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
```

```typescript
// ANTES — propiedades de clase (líneas 19–20):
private readonly genAI: GoogleGenerativeAI;
private readonly modelName: string;

// DESPUÉS:
private readonly logger = new Logger(BankStatementParserService.name);
private readonly genAI: GoogleGenerativeAI;
private readonly modelName: string;
```

---

### 1.1 — Fix `parseAmount`: heurística `lastComma > lastDot`

**Problema**: `"150.000,00"` → devuelve `150` en lugar de `150000`.
El código actual maneja `coma sin punto` pero cuando hay ambos asume que la coma es separador de miles (anglosajón).

**Solución**: comparar la posición del último separador para inferir cuál es el decimal.

```typescript
// ANTES (líneas 373–388):
private parseAmount(val: unknown): number | null {
  if (typeof val === 'number') {
    return val;
  }
  if (typeof val === 'string') {
    const clean = val.replace(/[^0-9.,-]/g, '');
    if (!clean) return null;

    if (clean.includes(',') && !clean.includes('.')) {
      const normalized = clean.replace(/\./g, '').replace(',', '.');
      const parsed = parseFloat(normalized);
      return Number.isNaN(parsed) ? null : parsed;
    }

    const normalized = clean.replace(/,/g, '');
    const parsed = parseFloat(normalized);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// DESPUÉS:
private parseAmount(val: unknown): number | null {
  if (typeof val === 'number') return val;
  if (typeof val !== 'string') return null;

  const clean = val.replace(/[^0-9.,-]/g, '');
  if (!clean) return null;

  const lastComma = clean.lastIndexOf(',');
  const lastDot = clean.lastIndexOf('.');

  if (lastComma > lastDot) {
    // Formato europeo: punto=miles, coma=decimal → "150.000,00" o "123,45"
    const normalized = clean.replace(/\./g, '').replace(',', '.');
    const parsed = parseFloat(normalized);
    return Number.isNaN(parsed) ? null : parsed;
  }

  // Formato estándar: coma=miles, punto=decimal → "1,234.56" o "150000"
  const normalized = clean.replace(/,/g, '');
  const parsed = parseFloat(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}
```

**Tabla de verificación de la nueva lógica**:

| Input | lastComma | lastDot | Resultado | Correcto |
|-------|-----------|---------|-----------|----------|
| `"150.000,00"` | 7 | 3 | 7>3 → europeo → `150000` | ✅ |
| `"123,45"` | 3 | -1 | 3>-1 → europeo → `123.45` | ✅ |
| `"1,234.56"` | 1 | 5 | 1<5 → estándar → `1234.56` | ✅ |
| `"150000.00"` | -1 | 6 | -1<6 → estándar → `150000` | ✅ |
| `"150000"` | -1 | -1 | -1>-1 false → estándar → `150000` | ✅ |

---

### 1.2 — Fix `eachCell`: agregar `{ includeEmpty: true }`

**Problema**: celdas vacías intermedias en Excel se saltan, desalineando columnas.

```typescript
// ANTES (línea 140):
worksheet.eachRow((row) => {
  const cells: string[] = [];
  row.eachCell((cell) => {

// DESPUÉS:
worksheet.eachRow((row) => {
  const cells: string[] = [];
  row.eachCell({ includeEmpty: true }, (cell) => {
```

---

### 1.3 — Fix `safeJsonParse`: cubrir `Unexpected end of JSON input`

**Problema**: el recovery solo se activa para `"Unterminated string"` o `"position"`, pero el error de truncamiento limpio es `"Unexpected end of JSON input"` que no contiene ninguna de las dos palabras.

```typescript
// ANTES (línea 230):
if (
  errorMsg.includes('Unterminated string') ||
  errorMsg.includes('position')
) {

// DESPUÉS:
if (
  errorMsg.includes('Unterminated string') ||
  errorMsg.includes('position') ||
  errorMsg.includes('Unexpected end')
) {
```

---

### 1.4 — Agregar `FinishReason` al import de `@google/generative-ai`

Solo el import. El uso real de `FinishReason` queda para la Fase 2 donde se reescribe `parseStatement` en su totalidad (hacerlo ahora en el path PDF sería trabajo que se sobreescribe en 2.4).

```typescript
// ANTES (línea 3):
import { GoogleGenerativeAI, Part } from '@google/generative-ai';

// DESPUÉS:
import { FinishReason, GoogleGenerativeAI, Part } from '@google/generative-ai';
```

---

### 1.5 — Mejorar logging antes del rethrow

**Problema**: el `catch` externo convierte todo en un 500 genérico sin traza del origen.

```typescript
// ANTES (líneas 86–92):
} catch (error) {
  throw new InternalServerErrorException(
    'Error al procesar el estado de cuenta bancario con IA',
    (error as Error).message,
  );
}

// DESPUÉS:
} catch (error) {
  this.logger.error(
    '[BankParser] Error procesando estado de cuenta',
    (error as Error).message,
  );
  throw new InternalServerErrorException(
    'Error al procesar el estado de cuenta bancario con IA',
    (error as Error).message,
  );
}
```

---

### 1.6 — Mejorar el prompt: `buildPrompt()`

Cuatro ajustes al texto del prompt para mejorar el índice de aciertos en estados de cuenta venezolanos de Bs.

```typescript
// ANTES — sección MONTOS:
MONTOS:
- Usa valores numéricos positivos para los ingresos.
- Convierte montos con separadores locales (puntos/comas) a un número decimal estándar.

// DESPUÉS:
MONTOS:
- Usa valores numéricos positivos para los ingresos.
- Devuelve "amount" SIEMPRE como número JSON (no string), con punto como separador decimal y SIN separador de miles. Ejemplo: 150000.00, no "150.000,00".
```

```typescript
// ANTES — sección REFERENCIAS:
REFERENCIAS:
- Si existe una columna explícita de referencia, úsala.
- Si NO hay columna de referencia explícita, BUSCA dentro de la descripción cualquier cadena numérica o alfanumérica que parezca código de referencia o número de operación.
- Normaliza la referencia eliminando espacios innecesarios, pero conserva el contenido alfanumérico completo.

// DESPUÉS:
REFERENCIAS:
- Si existe una columna explícita de referencia, úsala.
- Si NO hay columna de referencia explícita, BUSCA dentro de la descripción cualquier secuencia de 8 a 20 dígitos consecutivos que represente el número de operación o referencia bancaria. En estados de cuenta venezolanos (Pago Móvil, transferencias interbancarias) estos números son críticos para la conciliación.
- Extrae la referencia EXACTAMENTE como aparece: no agregues ni quites dígitos.
- Normaliza eliminando espacios, pero conserva el contenido alfanumérico completo.
```

```typescript
// ANTES — sección INSTRUCCIONES GENERALES (segunda línea):
- Extrae TODAS las transacciones de ingreso (dinero entrante hacia la cuenta). En este documento, TODAS las filas de la tabla de movimientos marcadas con el Tipo "NC" (Nota de Crédito) son ingresos y deben ser extraídas, sin importar su descripción (incluye "PAGO MOVIL", "PAGO A TERCEROS", "CREDITO", etc.).

// DESPUÉS:
- Extrae TODAS las transacciones de ingreso (dinero entrante hacia la cuenta). Son ingresos las filas marcadas como "NC" (Nota de Crédito), "CR", "ABONO", "CREDITO", "ACREDITADO" o cualquier indicador de entrada de fondos, sin importar su descripción (incluye "PAGO MOVIL", "PAGO A TERCEROS", "CREDITO", etc.).
```

```typescript
// ANTES — última regla de REGLAS CRÍTICAS PARA EL JSON:
- NO envíes comentarios, explicaciones, ni otro tipo de texto fuera de este JSON.

// DESPUÉS:
- NO envíes comentarios, explicaciones, ni otro tipo de texto fuera de este JSON.
- Procesa ABSOLUTAMENTE TODAS las filas del contenido recibido sin omitir ninguna, aunque el archivo sea un fragmento de un documento mayor.
```

---

### 1.7 — Typecheck + lint de la Fase 1

```bash
npx tsc --noEmit
npx eslint src/modules/purchases/services/bank-statement-parser.service.ts --max-warnings=0
```

### 1.7 — Typecheck + lint de la Fase 1

```bash
npx tsc --noEmit
npx eslint src/modules/purchases/services/bank-statement-parser.service.ts --max-warnings=0
```

---

## Fase 2 — Chunking para CSV/Excel

**Problema raíz**: CSV/Excel con >160 filas produce >8,192 tokens de salida — Gemini trunca silenciosamente.

**Solución**: dividir el CSV en fragmentos de `CHUNK_SIZE` filas, llamar a Gemini una vez por fragmento, concatenar resultados. El header row (primera fila) se incluye en cada fragmento para que la IA conozca la estructura de columnas.

```
CSV de 400 filas
    ↓ split
Chunk 1: [header + filas 1..100]   → callGeminiText() → 100 tx
Chunk 2: [header + filas 101..200] → callGeminiText() → 100 tx
Chunk 3: [header + filas 201..300] → callGeminiText() → 100 tx
Chunk 4: [header + filas 301..400] → callGeminiText() → 100 tx
    ↓ concat
400 BankTransaction[]
```

### 2.1 — Agregar constante `CHUNK_SIZE`

Añadir junto a las propiedades de clase (después del constructor):

```typescript
private readonly CHUNK_SIZE = 100;
```

Justificación: 100 filas × ~50 tokens/tx = ~5,000 tokens de salida, bien por debajo del límite de 8,192.

---

### 2.2 — Extraer `callGeminiText(textContent: string)`

Este método encapsula la llamada a Gemini para contenido de texto (CSV/Excel/fallback). Incluye el check de `finishReason`.

```typescript
private async callGeminiText(textContent: string): Promise<BankTransaction[]> {
  const model = this.genAI.getGenerativeModel({
    model: this.modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.0,
    },
  });

  const result = await model.generateContent([
    { text: this.buildPrompt() },
    { text: textContent },
  ]);

  const finishReason = result.response.candidates?.[0]?.finishReason;
  if (finishReason === FinishReason.MAX_TOKENS) {
    this.logger.warn(
      '[BankParser] Gemini alcanzó MAX_TOKENS en chunk de texto — posible truncamiento',
    );
  }

  const rawText = result.response.text();
  const parsed = this.safeJsonParse(rawText);
  return this.mapToBankTransactions(parsed);
}
```

---

### 2.3 — Agregar `parseInChunks(rows: string[])`

```typescript
private async parseInChunks(rows: string[]): Promise<BankTransaction[]> {
  if (rows.length === 0) return [];

  const [headerRow, ...dataRows] = rows;

  if (dataRows.length <= this.CHUNK_SIZE) {
    return this.callGeminiText(rows.join('\n'));
  }

  const results: BankTransaction[] = [];
  for (let i = 0; i < dataRows.length; i += this.CHUNK_SIZE) {
    const chunk = dataRows.slice(i, i + this.CHUNK_SIZE);
    const chunkText = [headerRow, ...chunk].join('\n');
    const transactions = await this.callGeminiText(chunkText);
    results.push(...transactions);
  }
  return results;
}
```

**Por qué `headerRow` en cada chunk**: la IA necesita los títulos de columna para saber cuál columna es la referencia, cuál el monto, etc. Sin el header, puede confundir columnas entre chunks.

**Por qué secuencial y no paralelo**: evita rate limiting de la API de Gemini. Los estados de cuenta venezolanos raramente superan las 400 filas. 4 llamadas secuenciales son suficiente.

---

### 2.4 — Actualizar `parseStatement` para usar los nuevos métodos

El método público queda reorganizado en tres paths:

```typescript
async parseStatement(
  buffer: Buffer,
  mimeType: string,
): Promise<BankTransaction[]> {
  try {
    let transactions: BankTransaction[];

    if (this.isSpreadsheetOrCsv(mimeType)) {
      // Path CSV/Excel: chunking automático
      const csvContent = await this.getSpreadsheetOrCsvContent(buffer, mimeType);
      const rows = csvContent.split('\n').filter((r) => r.trim() !== '');
      transactions = await this.parseInChunks(rows);

    } else if (this.isPdfOrImage(mimeType)) {
      // Path PDF/imagen: llamada única (no se puede chunkar)
      const model = this.genAI.getGenerativeModel({
        model: this.modelName,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.0,
        },
      });
      const imagePart: Part = {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType,
        },
      };
      const result = await model.generateContent([
        { text: this.buildPrompt() },
        imagePart,
      ]);
      const finishReason = result.response.candidates?.[0]?.finishReason;
      if (finishReason === FinishReason.MAX_TOKENS) {
        this.logger.warn(
          '[BankParser] Gemini alcanzó MAX_TOKENS en PDF/imagen — la respuesta puede estar incompleta',
        );
      }
      const rawText = result.response.text();
      const parsed = this.safeJsonParse(rawText);
      transactions = this.mapToBankTransactions(parsed);

    } else {
      // Path fallback: texto plano, llamada única
      transactions = await this.callGeminiText(buffer.toString('utf8'));
    }

    if (!transactions.length) {
      throw new InternalServerErrorException(
        'No se detectaron transacciones de crédito en el archivo provisto',
      );
    }

    return transactions;
  } catch (error) {
    this.logger.error(
      '[BankParser] Error procesando estado de cuenta',
      (error as Error).message,
    );
    throw new InternalServerErrorException(
      'Error al procesar el estado de cuenta bancario con IA',
      (error as Error).message,
    );
  }
}
```

**Nota**: el path PDF/imagen conserva su lógica original excepto que se elimina el `const response = await result.response` (era redundante, `result.response` ya es el objeto de respuesta, no una Promise).

---

### 2.5 — Typecheck + lint de la Fase 2

```bash
npx tsc --noEmit
npx eslint src/modules/purchases/services/bank-statement-parser.service.ts --max-warnings=0
```

---

## Fase 3 — Validación final

- [ ] **3.1** `npm run build` — build completo, cero errores TypeScript
- [ ] **3.2** `npm run lint` — cero errores/warnings en el archivo modificado

---

## TODO List

### Fase 1 — Correcciones locales

- [ ] **1.0** Agregar `Logger` al import de `@nestjs/common` y declarar `private readonly logger = new Logger(BankStatementParserService.name)` en la clase ⚠️ prerequisito
- [ ] **1.1** Reemplazar `parseAmount` completo con la versión `lastComma > lastDot`
- [ ] **1.2** Cambiar `row.eachCell((cell) =>` por `row.eachCell({ includeEmpty: true }, (cell) =>`
- [ ] **1.3** Agregar `errorMsg.includes('Unexpected end')` a la condición del recovery en `safeJsonParse`
- [ ] **1.4** Añadir `FinishReason` al import de `@google/generative-ai` (solo el import — el uso queda para 2.4)
- [ ] **1.5** Agregar `this.logger.error(...)` antes del `throw` en el catch principal de `parseStatement`
- [ ] **1.6** Actualizar `buildPrompt()`: (a) amount como número sin separador de miles, (b) referencias venezolanas 8–20 dígitos, (c) tipos de crédito: NC/CR/ABONO/CREDITO/ACREDITADO, (d) procesar todas las filas del fragmento recibido
- [ ] **1.7** Typecheck (`npx tsc --noEmit`) — cero errores
- [ ] **1.8** Lint (`npx eslint ... --max-warnings=0`) — cero errores en el archivo

---

### Fase 2 — Chunking para CSV/Excel

- [ ] **2.1** Agregar constante de clase `private readonly CHUNK_SIZE = 100;`
- [ ] **2.2** Agregar método privado `callGeminiText(textContent: string): Promise<BankTransaction[]>` con la lógica de llamada a Gemini texto + finishReason + safeJsonParse + mapToBankTransactions
- [ ] **2.3** Agregar método privado `parseInChunks(rows: string[]): Promise<BankTransaction[]>` con el loop de chunking secuencial
- [ ] **2.4** Reescribir `parseStatement` para usar los tres paths: CSV/Excel → `parseInChunks`, PDF/imagen → inline con finishReason, fallback → `callGeminiText`
- [ ] **2.5** Eliminar el bloque de código de llamada a Gemini que quedó duplicado tras la refactorización (asegurarse de que no haya `model.generateContent` duplicado para el path texto)
- [ ] **2.6** Typecheck (`npx tsc --noEmit`) — cero errores
- [ ] **2.7** Lint (`npx eslint ... --max-warnings=0`) — cero errores en el archivo

---

### Fase 3 — Build y validación final

- [ ] **3.1** `npm run build` — confirmar cero errores de compilación TypeScript
- [ ] **3.2** `npm run lint` — confirmar cero errores/warnings en el archivo modificado
- [ ] **3.3** Verificar manualmente con un CSV de >160 filas que ahora se procesan todas las transacciones correctamente
