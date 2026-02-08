import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';
import { join } from 'path';

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
    if (!this.sheets) {
      throw new Error('Google Sheets client not initialized');
    }
    if (!values.length) {
      return;
    }

    const range = `${sheetName}!A:A`;
    await this.sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
  }
}
