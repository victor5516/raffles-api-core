# Investigación Profunda: BankStatementParserService — Llamada IA y Límites de JSON

---

## Flujo completo de la llamada a Gemini

```
parseStatement(buffer, mimeType)
    │
    ├─ [spreadsheet/csv] → getSpreadsheetOrCsvContent()
    │       ├─ CSV    → buffer.toString('utf8')
    │       └─ Excel  → bufferToCsv()  [ExcelJS → CSV string]
    │
    ├─ [pdf/image]    → buffer.toString('base64') como inlineData
    │
    └─ [otro]         → buffer.toString('utf8')
    │
    ▼
model.generateContent(parts)   ← UN SOLO REQUEST, sin chunking
    │
    ▼
response.text()                ← string crudo (potencialmente truncado)
    │
    ▼
safeJsonParse(rawText)         ← intenta parsear; tiene recuperación parcial
    │
    ▼
mapToBankTransactions(parsed)  ← filtra inválidos, normaliza campos
    │
    ▼
BankTransaction[]
```

---

## Configuración del modelo — qué está y qué falta

```typescript
const model = this.genAI.getGenerativeModel({
  model: this.modelName,           // 'gemini-2.0-flash' por defecto
  generationConfig: {
    responseMimeType: 'application/json',
    temperature: 0.0,
    // ⚠️  maxOutputTokens: NO CONFIGURADO → usa el default del modelo
  },
});
```

**`maxOutputTokens` no está configurado.** El modelo usa su límite por defecto.

| Modelo | Output tokens por defecto | Output tokens máximo configurabile |
|--------|--------------------------|-------------------------------------|
| gemini-2.0-flash | 8,192 | 8,192 |
| gemini-1.5-flash | 8,192 | 8,192 |
| gemini-1.5-pro   | 8,192 | 8,192 |

> El límite de salida de Gemini no es configurable más allá de 8,192 tokens en la familia Flash/Pro estándar — es un techo fijo del modelo, no solo un default.

---

## Estimación de tokens por transacción Bs

Una transacción típica de un estado de cuenta venezolano serializada en JSON:

```json
{
  "date": "2026-02-15",
  "rawDate": "15/02/26",
  "amount": 150000.00,
  "reference": "005101282438",
  "description": "PAGO MOVIL ORIGEN 00510 BANCO MERCANTIL"
}
```

- Caracteres: ~175
- Tokens estimados (≈ 1 token / 3.5 chars): **~50 tokens por transacción**
- Overhead del wrapper JSON (`{"transactions":[`, `]}`): ~10 tokens

| Transacciones | Tokens output estimados | Cabe en 8,192 tokens? |
|---------------|------------------------|----------------------|
| 50            | ~2,510                 | ✅ Sí                 |
| 100           | ~5,010                 | ✅ Sí                 |
| 160           | ~8,010                 | ⚠️ Límite             |
| 200           | ~10,010                | ❌ Truncado           |
| 400           | ~20,010                | ❌ Truncado (~155 llegan) |

**Con 400 transacciones, Gemini solo puede devolver ~155–165 transacciones antes de alcanzar el límite de 8,192 tokens.** El resto se pierde silenciosamente.

---

## Cómo trunca Gemini con `responseMimeType: 'application/json'`

`responseMimeType: 'application/json'` activa **constrained decoding**: el modelo fuerza que su salida sea JSON sintácticamente válido. Cuando alcanza el límite de tokens, el decodificador tiene dos comportamientos observados:

### Escenario A — Truncamiento limpio (JSON válido pero incompleto)

Gemini cierra el último array/objeto abierto para producir JSON válido:
```json
{
  "transactions": [
    { "date": "...", "amount": 100, "reference": "...", "description": "..." },
    { "date": "...", "amount": 200, "reference": "...", "description": "..." }
  ]
}
```
→ **`JSON.parse` tiene ÉXITO.** `safeJsonParse` devuelve sin error.
→ **Pérdida silenciosa**: el código procesa 2 transacciones cuando había 400. No hay error, no hay warning.
→ **`finishReason` del response sería `MAX_TOKENS` — pero el código NUNCA lo revisa.**

### Escenario B — Truncamiento sucio (JSON inválido, corte a mitad de un string)

```json
{
  "transactions": [
    { "date": "...", "amount": 100, "reference": "...", "description": "PAGO MOV
```
→ `JSON.parse` lanza `SyntaxError: Unterminated string in JSON at position N`
→ El código entra al **camino de recuperación** en `safeJsonParse`.

---

## Análisis del algoritmo de recuperación en `safeJsonParse`

### Cuándo se activa

```typescript
if (errorMsg.includes('Unterminated string') || errorMsg.includes('position')) {
```

Cubre los mensajes de V8:
- `Unterminated string in JSON at position N` ✅
- `Unexpected token X in JSON at position N` ✅
- `Unexpected end of JSON input` ❌ **NO LO CUBRE** — sin "position" ni "Unterminated string"

### Qué hace el algoritmo de recuperación

Itera carácter a carácter desde el inicio del array `[`, rastreando:
- `inString`: si estamos dentro de un string JSON
- `escapeNext`: si el próximo carácter está escapado con `\`
- `braceDepth`: profundidad de llaves `{}`
- Cuando `braceDepth` vuelve a 0 → encontró un objeto completo → `JSON.parse` individual y push

Resultado: extrae todos los objetos `{}` **completos y válidos** antes del punto de truncamiento.

### Bug en la condición `!escapeNext`

```typescript
if (char === '"' && !escapeNext) {  // escapeNext siempre es false aquí
  inString = !inString;
```

El check `!escapeNext` es **redundante pero no incorrecto**: cuando `escapeNext` es `true`, el `continue` de las líneas anteriores ya previene llegar aquí. La lógica funciona, pero el flag nunca puede ser `true` en ese punto.

### Punto ciego del algoritmo: `Unexpected end of JSON input`

Si Gemini trunca limpiamente (Escenario A) con un JSON bien cerrado pero corto, `JSON.parse` **tiene éxito** y la recuperación nunca se activa. Las transacciones faltantes se pierden sin diagnóstico alguno.

---

## `finishReason` — la señal ignorada

La respuesta de Gemini tiene el campo `candidates[0].finishReason`:

| Valor | Significado |
|-------|-------------|
| `STOP` | Generación completada normalmente |
| `MAX_TOKENS` | Cortado por límite de tokens — **datos incompletos** |
| `SAFETY` | Bloqueado por filtros de contenido |
| `RECITATION` | Bloqueado por derechos de autor |

El código actual:
```typescript
const result = await model.generateContent(parts);
const response = await result.response;
const rawText = response.text();  // ← único uso del response
```

**Nunca se accede a `result.response.candidates[0].finishReason`.** Un `MAX_TOKENS` pasa inadvertido.

---

## Bug en `parseAmount` para formato venezolano `150.000,00`

Las descripciones de estados de cuenta venezolanos usan el formato europeo: punto como separador de miles, coma como decimal.

```typescript
private parseAmount(val: unknown): number | null {
  const clean = val.replace(/[^0-9.,-]/g, '');

  // Caso: tiene coma Y NO tiene punto → formato latino
  if (clean.includes(',') && !clean.includes('.')) {
    // "150000,00" → "150000.00" → 150000 ✓
  }

  // Caso estándar: tiene ambos O solo punto
  const normalized = clean.replace(/,/g, '');
  // "150.000,00" → limpia comas → "150.00000" → parseFloat → 150 ✗ INCORRECTO
  //  ^               ^                ^                         ^
  //  input           ambos presentes  quita comas               solo toma hasta el primer punto
```

**El formato `"150.000,00"` (euros/Venezuela) devuelve `150` en lugar de `150000`.**

La condición solo maneja el caso `coma sin punto`. Cuando hay ambos (punto de miles + coma decimal), el código asume que la coma es separador de miles (formato anglosajón) y lo elimina, resultando en `150.00000` → `150`.

---

## Error swallowing total — pérdida de contexto diagnóstico

```typescript
try {
  // ... todo el proceso ...
} catch (error) {
  throw new InternalServerErrorException(
    'Error al procesar el estado de cuenta bancario con IA',
    (error as Error).message,
  );
}
```

El `catch` envuelve **todo**: el parsing de Excel, la llamada a Gemini, el parseo del JSON, la normalización. Cualquier error se convierte en un 500 genérico. No hay forma de distinguir desde el log si:
- Gemini devolvió JSON inválido
- El archivo Excel estaba corrupto
- Se alcanzó el límite de tokens
- Hubo un error de red con la API de Gemini

---

## Problema con Excel de muchas columnas: `eachCell` sin `includeEmpty`

```typescript
worksheet.eachRow((row) => {
  const cells: string[] = [];
  row.eachCell((cell) => {   // ← sin { includeEmpty: true }
    cells.push(text);
  });
  rows.push(cells.join(','));
});
```

`eachCell` sin `{ includeEmpty: true }` **salta las celdas vacías** y sus índices. Si una fila tiene datos en columnas A, B, D (vacía C), el CSV resultante tendrá solo 3 columnas en esa fila en lugar de 4. Esto desalinea columnas para las filas que tengan huecos intermedios, haciendo que la IA lea datos en la columna equivocada.

---

## Resumen de problemas encontrados

| # | Problema | Severidad | Escenario |
|---|----------|-----------|-----------|
| 1 | **`maxOutputTokens` no configurado** — 400 tx → ~155 llegan | Crítico | > 160 transacciones |
| 2 | **`finishReason` nunca revisado** — pérdida silenciosa sin error | Crítico | Siempre que se trunca |
| 3 | **Recuperación no cubre `Unexpected end of JSON input`** | Alto | Truncamiento limpio |
| 4 | **`parseAmount` falla con `150.000,00`** (formato Bs europeo) | Alto | Bs con miles separados por punto |
| 5 | **`eachCell` sin `includeEmpty: true`** — columnas desalineadas | Medio | Excel con celdas vacías intermedias |
| 6 | **Error swallowing total** — 500 genérico sin contexto | Medio | Cualquier error en el flujo |

---

## Archivos relacionados

| Archivo | Rol |
|---------|-----|
| `services/bank-statement-parser.service.ts` | Servicio investigado |
| `services/reconciliation.service.ts` | Consumidor del parser |
| `dto/reconciliation.dto.ts` | Tipo `BankTransaction` |
