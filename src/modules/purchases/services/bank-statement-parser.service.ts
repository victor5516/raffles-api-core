import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FinishReason, GoogleGenerativeAI, Part } from '@google/generative-ai';
import * as ExcelJS from 'exceljs';
import { BankTransaction } from '../dto/reconciliation.dto';

interface GeminiBankStatementResponse {
  transactions?: Array<{
    date?: string;
    rawDate?: string;
    amount?: number | string;
    reference?: string;
    description?: string;
  }>;
}

@Injectable()
export class BankStatementParserService {
  private readonly logger = new Logger(BankStatementParserService.name);
  private readonly genAI: GoogleGenerativeAI;
  private readonly modelName: string;
  private readonly CHUNK_SIZE = 100;

  constructor(private readonly configService: ConfigService) {
    const apiKey =
      this.configService.get<string>('GEMINI_API_KEY') ??
      process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is missing');
    }

    this.genAI = new GoogleGenerativeAI(apiKey);

    this.modelName =
      this.configService.get<string>('IA_MODEL') ?? 'gemini-2.0-flash';
  }

  async parseStatement(
    buffer: Buffer,
    mimeType: string,
  ): Promise<BankTransaction[]> {
    try {
      let transactions: BankTransaction[];

      if (this.isSpreadsheetOrCsv(mimeType)) {
        // Path CSV/Excel: chunking automático
        const csvContent = await this.getSpreadsheetOrCsvContent(
          buffer,
          mimeType,
        );
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

  private async callGeminiText(
    textContent: string,
  ): Promise<BankTransaction[]> {
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

  private isSpreadsheetOrCsv(mimeType: string): boolean {
    return (
      mimeType ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel' ||
      mimeType === 'text/csv' ||
      mimeType === 'application/csv'
    );
  }

  private isPdfOrImage(mimeType: string): boolean {
    return mimeType === 'application/pdf' || mimeType.startsWith('image/');
  }

  private async getSpreadsheetOrCsvContent(
    buffer: Buffer,
    mimeType: string,
  ): Promise<string> {
    if (mimeType === 'text/csv' || mimeType === 'application/csv') {
      return buffer
        .toString('utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
    }
    return this.bufferToCsv(buffer);
  }

  private async bufferToCsv(buffer: Buffer): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new InternalServerErrorException(
        'El archivo de estado de cuenta no contiene hojas válidas',
      );
    }

    const rows: string[] = [];

    worksheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const value = cell.value;
        let text =
          value === null || value === undefined
            ? ''
            : typeof value === 'object' && 'text' in (value as any)
              ? String((value as any).text)
              : String(value);

        // Escapar comillas y comas estilo CSV simple
        if (text.includes('"')) {
          text = text.replace(/"/g, '""');
        }
        if (text.includes(',') || text.includes('"') || text.includes('\n')) {
          text = `"${text}"`;
        }

        cells.push(text);
      });
      rows.push(cells.join(','));
    });

    return rows.join('\n');
  }

  private buildPrompt(): string {
    return `
Eres un analista financiero experto en conciliar estados de cuenta bancarios.

INSTRUCCIONES GENERALES:
- Analiza el estado de cuenta bancario proporcionado.
- Extrae TODAS las transacciones de ingreso (dinero entrante hacia la cuenta). Son ingresos las filas marcadas como "NC" (Nota de Crédito), "CR", "ABONO", "CREDITO", "ACREDITADO" o cualquier indicador de entrada de fondos, sin importar su descripción (incluye "PAGO MOVIL", "PAGO A TERCEROS", "CREDITO", etc.).
- IGNORA completamente débitos (ND), comisiones, intereses, saldos iniciales/finales y movimientos que NO representen dinero entrante.
- Si el documento incluye varias cuentas, céntrate en las transacciones de crédito de la cuenta principal mostrada.

REFERENCIAS:
- Si existe una columna explícita de referencia, úsala.
- Si NO hay columna de referencia explícita, BUSCA dentro de la descripción cualquier secuencia de 8 a 20 dígitos consecutivos que represente el número de operación o referencia bancaria. En estados de cuenta venezolanos (Pago Móvil, transferencias interbancarias) estos números son críticos para la conciliación.
- Extrae la referencia EXACTAMENTE como aparece: no agregues ni quites dígitos.
- Normaliza eliminando espacios, pero conserva el contenido alfanumérico completo.

FECHAS:
- Normaliza todas las fechas a formato YYYY-MM-DD cuando sea posible.
- Si la fecha original es ambigua (por ejemplo, falta el año o el mes), haz la mejor inferencia posible y guarda la fecha original en el campo "rawDate".
- SIEMPRE guarda la fecha original exacta tal como aparece en el documento en el campo "rawDate" sin modificar ni regionalizar.
- El campo "date" debe ser YYYY-MM-DD normalizado, pero "rawDate" debe mantener el formato original del documento.

MONTOS:
- Usa valores numéricos positivos para los ingresos.
- Devuelve "amount" SIEMPRE como número JSON (no string), con punto como separador decimal y SIN separador de miles. Ejemplo: 150000.00, no "150.000,00".

SALIDA JSON ESTRICTA:
- Devuelve EXCLUSIVAMENTE un JSON válido y completo con la siguiente forma, sin texto adicional antes o después:
{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "rawDate": "string opcional con la fecha original si es útil",
      "amount": 123.45,
      "reference": "string con la referencia detectada",
      "description": "descripción de la transacción según el estado de cuenta"
    }
  ]
}

REGLAS CRÍTICAS PARA EL JSON:
- ESCAPA correctamente todos los caracteres especiales en los strings (comillas dobles deben ser \", saltos de línea deben ser \n, etc.).
- Asegúrate de que todas las comillas dobles dentro de los valores de string estén escapadas con barra invertida (\\).
- El JSON debe estar completo y contener ABSOLUTAMENTE TODAS las transacciones "NC" encontradas, sin omitir ninguna.
- NO envíes comentarios, explicaciones, ni otro tipo de texto fuera de este JSON.
- Procesa ABSOLUTAMENTE TODAS las filas del contenido recibido sin omitir ninguna, aunque el archivo sea un fragmento de un documento mayor.
`.trim();
  }

  private safeJsonParse(rawText: string): GeminiBankStatementResponse {
    let cleaned = rawText.trim();

    // El modelo a veces envuelve la respuesta en bloques \`\`\`json ... \`\`\`
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/```json|```/g, '').trim();
    }

    // Intentar parsear directamente primero
    try {
      const parsed = JSON.parse(cleaned);
      return parsed as GeminiBankStatementResponse;
    } catch (firstError) {
      const errorMsg = (firstError as Error).message;

      // Si el error indica un string sin terminar (JSON truncado), intentar recuperar objetos completos
      if (
        errorMsg.includes('Unterminated string') ||
        errorMsg.includes('position') ||
        errorMsg.includes('Unexpected end')
      ) {
        try {
          const jsonStart = cleaned.indexOf('{');
          if (jsonStart === -1) {
            throw new Error('No se encontró el inicio del objeto JSON');
          }

          const transactionsKeyIndex = cleaned.indexOf(
            '"transactions"',
            jsonStart,
          );
          if (transactionsKeyIndex === -1) {
            throw new Error('No se encontró la clave "transactions"');
          }

          const arrayStart = cleaned.indexOf('[', transactionsKeyIndex);
          if (arrayStart === -1) {
            throw new Error('No se encontró el inicio del array');
          }

          // Buscar el último objeto completo balanceado antes del truncamiento
          const transactions: NonNullable<
            GeminiBankStatementResponse['transactions']
          > = [];
          let i = arrayStart + 1;
          let objStart = -1;
          let braceDepth = 0;
          let inString = false;
          let escapeNext = false;

          while (i < cleaned.length) {
            const char = cleaned[i];

            if (escapeNext) {
              escapeNext = false;
              i++;
              continue;
            }

            if (char === '\\') {
              escapeNext = true;
              i++;
              continue;
            }

            if (char === '"' && !escapeNext) {
              inString = !inString;
              i++;
              continue;
            }

            if (inString) {
              i++;
              continue;
            }

            if (char === '{') {
              if (braceDepth === 0) {
                objStart = i;
              }
              braceDepth++;
            } else if (char === '}') {
              braceDepth--;
              if (braceDepth === 0 && objStart >= 0) {
                // Encontramos un objeto completo
                try {
                  const objStr = cleaned.slice(objStart, i + 1);
                  const parsed = JSON.parse(objStr);
                  transactions.push(parsed);
                } catch {
                  // Ignorar objetos que no se pueden parsear
                }
                objStart = -1;
              }
            }

            i++;
          }

          if (transactions.length > 0) {
            return {
              transactions,
            } as GeminiBankStatementResponse;
          }
        } catch (repairError) {
          // Si la reparación falla, continuar al error final
        }
      }

      // Si todo falla, lanzar error con contexto útil
      throw new InternalServerErrorException(
        `La respuesta de IA no es un JSON válido. El JSON puede estar truncado o contener caracteres especiales sin escapar. Error: ${errorMsg}. Longitud del texto recibido: ${cleaned.length} caracteres.`,
        errorMsg,
      );
    }
  }

  private mapToBankTransactions(
    payload: GeminiBankStatementResponse,
  ): BankTransaction[] {
    const items = Array.isArray(payload.transactions)
      ? payload.transactions
      : [];

    const transactions: BankTransaction[] = [];

    for (const item of items) {
      if (!item) continue;

      const amount = this.parseAmount(item.amount);
      if (amount === null || Number.isNaN(amount)) {
        continue;
      }

      const date = this.normalizeDate(item.date);
      if (!date) {
        continue;
      }

      const reference = (item.reference ?? '').toString().trim();
      const description = (item.description ?? '').toString().trim();

      // Preferir rawDate si está disponible y es válido, de lo contrario usar la fecha normalizada
      const finalRawDate = item.rawDate || item.date || null;

      transactions.push({
        date,
        amount,
        reference,
        description,
        rawDate: finalRawDate,
      });
    }

    return transactions;
  }

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

  private normalizeDate(input?: string): string | null {
    if (!input) return null;
    const trimmed = input.trim();
    if (!trimmed) return null;

    // Si ya viene en formato YYYY-MM-DD, retornarlo directamente
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }

    // Parsear formato DD/MM/YY o DD/MM/YYYY sin conversión de zona horaria
    const ddmmyyMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (ddmmyyMatch) {
      const day = parseInt(ddmmyyMatch[1], 10);
      const month = parseInt(ddmmyyMatch[2], 10);
      let year = parseInt(ddmmyyMatch[3], 10);

      // Si el año es de 2 dígitos, inferir el siglo (asumir 2000-2099)
      if (year < 100) {
        year = year < 50 ? 2000 + year : 1900 + year;
      }

      // Validar que los valores sean razonables
      if (
        day >= 1 &&
        day <= 31 &&
        month >= 1 &&
        month <= 12 &&
        year >= 1900 &&
        year <= 2100
      ) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }

    // Parsear formato MM/DD/YY o MM/DD/YYYY (formato americano)
    const mmddyyMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (mmddyyMatch) {
      const month = parseInt(mmddyyMatch[1], 10);
      const day = parseInt(mmddyyMatch[2], 10);
      let year = parseInt(mmddyyMatch[3], 10);

      if (year < 100) {
        year = year < 50 ? 2000 + year : 1900 + year;
      }

      if (
        day >= 1 &&
        day <= 31 &&
        month >= 1 &&
        month <= 12 &&
        year >= 1900 &&
        year <= 2100
      ) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }

    // Formato DD-MM-YYYY o DD-MM-YY
    const ddmmyyDashMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
    if (ddmmyyDashMatch) {
      const day = parseInt(ddmmyyDashMatch[1], 10);
      const month = parseInt(ddmmyyDashMatch[2], 10);
      let year = parseInt(ddmmyyDashMatch[3], 10);

      if (year < 100) {
        year = year < 50 ? 2000 + year : 1900 + year;
      }

      if (
        day >= 1 &&
        day <= 31 &&
        month >= 1 &&
        month <= 12 &&
        year >= 1900 &&
        year <= 2100
      ) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }

    // Como último recurso, intentar con Date pero usando solo la fecha local sin tiempo
    try {
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        const year = parsed.getFullYear();
        const month = parsed.getMonth() + 1;
        const day = parsed.getDate();

        if (
          year >= 1900 &&
          year <= 2100 &&
          month >= 1 &&
          month <= 12 &&
          day >= 1 &&
          day <= 31
        ) {
          return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
      }
    } catch {
      // Ignorar errores de parseo
    }

    return null;
  }
}
