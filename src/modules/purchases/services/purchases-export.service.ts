import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import axios from 'axios';
import { Response } from 'express';
import { Purchase, PurchaseStatus } from '../entities/purchase.entity';
import { PaymentMethod } from '../../payments/entities/payment-method.entity';
import { S3Service } from '../../../common/s3/s3.service';
import { formatDateVenezuela } from '../../../common/utils/date.util';

@Injectable()
export class PurchasesExportService {
  private readonly logger = new Logger(PurchasesExportService.name);

  constructor(private readonly s3Service: S3Service) {}

  /**
   * Generates a PDF of receipts for the given purchases and pipes it to the response.
   * Expects purchases with customer and paymentMethod relations loaded.
   * Does not perform any database queries.
   */
  async generateReceiptsPdf(
    purchases: Purchase[],
    res: Response,
    filename: string,
  ): Promise<void> {
    const doc = new PDFDocument({
      margin: 50,
      size: 'A4',
    });
    doc.pipe(res);

    for (let index = 0; index < purchases.length; index++) {
      const purchase = purchases[index];
      if (index > 0) {
        doc.addPage();
      }

      const evidenceKey =
        (purchase.payments ?? []).find((entry) => entry.evidenceUrl?.trim())
          ?.evidenceUrl ?? purchase.paymentScreenshotUrl;
      const evidenceUrl =
        (await this.s3Service.getPresignedGetUrl(evidenceKey)) ?? evidenceKey;

      doc
        .fontSize(16)
        .text(`Comprobante ${index + 1}`, { underline: true })
        .moveDown(0.7);
      doc
        .fontSize(11)
        .fillColor('black')
        .text(`Fecha: ${formatDateVenezuela(purchase.submittedAt)}`)
        .text(`Cliente: ${purchase.customer?.fullName || '-'}`)
        .text(`Cédula: ${purchase.customer?.nationalId || '-'}`)
        .text(`Referencia: ${purchase.bankReference || '-'}`)
        .text(`Monto: ${Number(purchase.totalAmount || 0).toFixed(2)}`)
        .moveDown();

      if (!evidenceUrl) {
        doc
          .fillColor('red')
          .fontSize(12)
          .text('Error cargando imagen: evidencia no disponible')
          .fillColor('black');
        continue;
      }

      try {
        const response = await axios.get<ArrayBuffer>(evidenceUrl, {
          responseType: 'arraybuffer',
          timeout: 15000,
        });
        const imageBuffer = Buffer.from(response.data);
        doc.image(imageBuffer, {
          fit: [500, 500],
          align: 'center',
          valign: 'center',
        });
      } catch (error) {
        this.logger.warn(
          `Failed to load evidence image for purchase ${purchase.uid}: ${error instanceof Error ? error.message : String(error)}`,
        );
        doc
          .fillColor('red')
          .fontSize(12)
          .text('Error cargando imagen')
          .fillColor('black');
      }
    }

    doc.end();
  }

  /**
   * Generates an Excel workbook from the given purchases and payment methods.
   * Groups purchases by paymentMethodId internally. Does not perform any database queries.
   */
  async generateExcel(
    purchases: Purchase[],
    paymentMethods: PaymentMethod[],
    summaryCurrencyLabel?: string,
  ): Promise<Buffer> {
    const purchasesByPaymentMethod = new Map<string, Purchase[]>();
    paymentMethods.forEach((pm) => purchasesByPaymentMethod.set(pm.uid, []));
    purchases.forEach((p) => {
      const pmId = p.paymentMethodId;
      if (purchasesByPaymentMethod.has(pmId)) {
        purchasesByPaymentMethod.get(pmId).push(p);
      }
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Raffles Admin';
    workbook.created = new Date();

    const statusLabels: Record<string, string> = {
      [PurchaseStatus.PENDING]: 'Pendiente',
      [PurchaseStatus.VERIFIED]: 'Verificado',
      [PurchaseStatus.REJECTED]: 'Rechazado',
      [PurchaseStatus.MANUAL_REVIEW]: 'Revisión Manual',
      [PurchaseStatus.DUPLICATED]: 'Duplicado',
    };

    const addHeaders = (worksheet: ExcelJS.Worksheet) => {
      worksheet.columns = [
        { header: 'Fecha', key: 'date', width: 18 },
        { header: 'Cliente', key: 'customer', width: 25 },
        { header: 'Cédula', key: 'nationalId', width: 15 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Teléfono', key: 'phone', width: 15 },
        { header: 'Tickets', key: 'ticketQty', width: 10 },
        { header: 'Monto', key: 'amount', width: 15 },
        { header: 'Referencia', key: 'reference', width: 20 },
        { header: 'Estado', key: 'status', width: 15 },
        { header: 'Vendedor', key: 'seller', width: 20 },
        { header: 'Rifa', key: 'raffle', width: 25 },
      ];
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' },
      };
    };

    const totals: {
      paymentMethod: string;
      currency: string;
      total: number;
    }[] = [];

    const summaryCurrency = summaryCurrencyLabel ?? 'Todas';

    for (const pm of paymentMethods) {
      const pmPurchases = purchasesByPaymentMethod.get(pm.uid) || [];
      const sheetName = pm.name.slice(0, 31).replace(/[*?:/\\[\]]/g, '-');
      const worksheet = workbook.addWorksheet(sheetName);

      addHeaders(worksheet);

      pmPurchases.forEach((p) => {
        const isDuplicated = p.status === PurchaseStatus.DUPLICATED;
        worksheet.addRow({
          date: formatDateVenezuela(p.submittedAt),
          customer: p.customer?.fullName || '-',
          nationalId: p.customer?.nationalId || '-',
          email: p.customer?.email || '-',
          phone: p.customer?.phone || '-',
          ticketQty: p.ticketQuantity,
          amount: isDuplicated
            ? '0,00'
            : Number(p.totalAmount).toFixed(2).replace('.', ','),
          reference: p.bankReference || '-',
          status: statusLabels[p.status] || p.status,
          seller: p.paymentMethod?.accountHolderName || '-',
          raffle: p.raffle?.title || '-',
        });
      });

      const pmTotal = pmPurchases.reduce(
        (sum, p) =>
          sum +
          (p.status === PurchaseStatus.DUPLICATED ? 0 : Number(p.totalAmount)),
        0,
      );
      totals.push({
        paymentMethod: pm.name,
        currency: pm.currency?.symbol || 'USD',
        total: pmTotal,
      });

      worksheet.addRow({});
      const totalRow = worksheet.addRow({
        phone: 'TOTAL:',
        ticketQty: pmPurchases.reduce(
          (sum, p) =>
            sum +
            (p.status === PurchaseStatus.DUPLICATED ? 0 : p.ticketQuantity),
          0,
        ),
        amount: pmTotal.toFixed(2).replace('.', ','),
      });
      totalRow.font = { bold: true };
    }

    const summarySheet = workbook.addWorksheet(`Totales ${summaryCurrency}`);
    summarySheet.columns = [
      { header: 'Método de Pago', key: 'paymentMethod', width: 30 },
      { header: 'Moneda', key: 'currency', width: 10 },
      { header: 'Total', key: 'total', width: 18 },
    ];
    summarySheet.getRow(1).font = { bold: true };

    let grandTotal = 0;
    totals.forEach((t) => {
      summarySheet.addRow(t);
      grandTotal += t.total;
    });

    summarySheet.addRow({});
    const grandTotalRow = summarySheet.addRow({
      paymentMethod: 'TOTAL GENERAL',
      total: grandTotal.toFixed(2).replace('.', ','),
    });
    grandTotalRow.font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
