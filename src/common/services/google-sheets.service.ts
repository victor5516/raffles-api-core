import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';
import { join } from 'path';

interface SheetSyncRow {
  uid: string;
  values: any[];
}

@Injectable()
export class GoogleSheetsService implements OnModuleInit {
  private readonly logger = new Logger(GoogleSheetsService.name);
  private sheets: sheets_v4.Sheets | null = null;

  async onModuleInit(): Promise<void> {
    try {
      const keyFilePath = join(process.cwd(), 'google-credentials.json');
      const auth = new google.auth.GoogleAuth({
        keyFile: keyFilePath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const authClient = await auth.getClient();
      this.sheets = google.sheets({ version: 'v4', auth: authClient as any });
      this.logger.log('Google Sheets client initialized');
    } catch (err) {
      this.logger.error(
        'Failed to initialize Google Sheets client',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Appends rows to a sheet. Uses USER_ENTERED so dates/numbers are formatted
   * by Google (keeps pivot tables and formulas working).
   */
  async appendRows(
    spreadsheetId: string,
    sheetName: string,
    values: any[][],
  ): Promise<void> {
    const sheets = this.getClient();
    if (!values.length) {
      return;
    }

    const range = this.rangeRef(sheetName, 'A:A');
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
  }

  /**
   * Ensures a sheet (tab) with the given name exists in the spreadsheet.
   * Creates it via the API if missing.
   */
  async ensureSheetExists(
    spreadsheetId: string,
    sheetName: string,
  ): Promise<void> {
    const sheets = this.getClient();
    const res = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(title))',
    });
    const existing = (res.data.sheets ?? []).some(
      (s) => (s.properties?.title ?? '').trim() === sheetName.trim(),
    );
    if (existing) {
      return;
    }
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetName.trim().slice(0, 100),
                gridProperties: { rowCount: 1000, columnCount: 26 },
              },
            },
          },
        ],
      },
    });
    this.logger.log(`Created sheet "${sheetName}" in spreadsheet ${spreadsheetId}`);
  }

  async getSheetValues(
    spreadsheetId: string,
    sheetName: string,
    range: string,
  ): Promise<any[][]> {
    const sheets = this.getClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: this.rangeRef(sheetName, range),
    });
    return response.data.values ?? [];
  }

  async syncRowsByUid(
    spreadsheetId: string,
    sheetName: string,
    rows: SheetSyncRow[],
    headers?: string[],
  ): Promise<void> {
    const sheets = this.getClient();
    if (!rows.length) {
      return;
    }

    await this.ensureSheetExists(spreadsheetId, sheetName);

    const maxRowLength = rows.reduce(
      (max, row) => Math.max(max, row.values.length),
      headers?.length ?? 0,
    );
    const columnCount = Math.max(maxRowLength, 1);
    const endColumn = this.columnLetterFromIndex(columnCount);
    const readRange = `A1:${endColumn}`;
    const existingRows = await this.getSheetValues(spreadsheetId, sheetName, readRange);

    let dataRows = existingRows;
    if (headers) {
      const headerRange = `A1:${this.columnLetterFromIndex(headers.length)}1`;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: this.rangeRef(sheetName, headerRange),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [headers] },
      });
      dataRows =
        existingRows.length > 0 && this.isHeaderRow(existingRows[0], headers)
          ? existingRows.slice(1)
          : [];
    }

    const uidColumnIndex = (headers?.length ?? columnCount) - 1;
    const existingRowsByUid = new Map<string, number[]>();

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const uid = String(row?.[uidColumnIndex] ?? '').trim();
      if (!uid) {
        continue;
      }
      const sheetRowIndex = headers ? i + 2 : i + 1;
      const indexes = existingRowsByUid.get(uid) ?? [];
      indexes.push(sheetRowIndex);
      existingRowsByUid.set(uid, indexes);
    }

    const incomingByUid = new Map<string, SheetSyncRow[]>();
    for (const row of rows) {
      const key = String(row.uid).trim();
      if (!key) {
        continue;
      }
      const current = incomingByUid.get(key) ?? [];
      current.push(row);
      incomingByUid.set(key, current);
    }

    const updateData: sheets_v4.Schema$ValueRange[] = [];
    const appendValues: any[][] = [];
    const blankRow = new Array(columnCount).fill('');

    for (const [uid, incomingRows] of incomingByUid) {
      const currentIndexes = [...(existingRowsByUid.get(uid) ?? [])].sort(
        (a, b) => a - b,
      );

      const isClearOp =
        incomingRows.length === 1 &&
        (!incomingRows[0].values || incomingRows[0].values.length === 0);

      if (isClearOp) {
        // Clear all existing rows for this UID by writing blank rows
        for (const staleIndex of currentIndexes) {
          updateData.push({
            range: this.rangeRef(sheetName, `A${staleIndex}:${endColumn}${staleIndex}`),
            values: [blankRow],
          });
        }
        continue;
      }

      const overlap = Math.min(currentIndexes.length, incomingRows.length);

      for (let i = 0; i < overlap; i++) {
        const rowIndex = currentIndexes[i];
        const values = incomingRows[i].values;
        updateData.push({
          range: this.rangeRef(sheetName, `A${rowIndex}:${endColumn}${rowIndex}`),
          values: [values],
        });
      }

      if (incomingRows.length > currentIndexes.length) {
        const missingRows = incomingRows.slice(currentIndexes.length);
        appendValues.push(...missingRows.map((entry) => entry.values));
      } else if (currentIndexes.length > incomingRows.length) {
        const staleIndexes = currentIndexes.slice(incomingRows.length);
        for (const staleIndex of staleIndexes) {
          updateData.push({
            range: this.rangeRef(sheetName, `A${staleIndex}:${endColumn}${staleIndex}`),
            values: [blankRow],
          });
        }
      }
    }

    if (updateData.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updateData,
        },
      });
    }

    if (appendValues.length > 0) {
      await this.appendRows(spreadsheetId, sheetName, appendValues);
    }
  }

  async replaceSheetRows(
    spreadsheetId: string,
    sheetName: string,
    headers: string[],
    rows: any[][],
  ): Promise<void> {
    const sheets = this.getClient();
    await this.ensureSheetExists(spreadsheetId, sheetName);
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: this.rangeRef(sheetName, 'A:ZZ'),
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: this.rangeRef(sheetName, 'A1'),
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [headers, ...rows],
      },
    });
  }

  private getClient(): sheets_v4.Sheets {
    if (!this.sheets) {
      throw new Error('Google Sheets client not initialized');
    }
    return this.sheets;
  }

  /**
   * Escapes sheet name for A1 notation (spaces/special chars require single quotes).
   * Single quotes inside the name are escaped by doubling.
   */
  private toSheetRangeName(sheetName: string): string {
    const escaped = String(sheetName ?? '').replace(/'/g, "''");
    return `'${escaped}'`;
  }

  private rangeRef(sheetName: string, a1Part: string): string {
    return `${this.toSheetRangeName(sheetName)}!${a1Part}`;
  }

  private isHeaderRow(row: any[] | undefined, headers: string[]): boolean {
    if (!row || row.length === 0) {
      return false;
    }
    for (let i = 0; i < headers.length; i++) {
      const current = String(row[i] ?? '').trim().toLowerCase();
      const expected = String(headers[i]).trim().toLowerCase();
      if (current !== expected) {
        return false;
      }
    }
    return true;
  }

  private columnLetterFromIndex(index: number): string {
    let current = index;
    let result = '';
    while (current > 0) {
      const remainder = (current - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      current = Math.floor((current - 1) / 26);
    }
    return result || 'A';
  }
}
