import { readFile } from 'fs/promises';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Handlebars from 'handlebars';
import { Resend } from 'resend';
import { Customer } from '../customers/entities/customer.entity';
import { Purchase } from '../purchases/entities/purchase.entity';

type PurchaseEmailTemplateContext = {
  brandName: string;
  logoUrl: string;
  customer: { fullName: string; email: string };
  purchase: {
    ticketNumbers: unknown[];
    totalAmount: unknown;
    bankReference: unknown;
    ticketQuantity: unknown;
    submittedAt?: string;
    verifiedAt?: string;
    notes?: string;
  };
  raffle: { title: string; description: string } | null;
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend;

  private readonly brandName: string;
  private readonly logoUrl: string;
  private readonly fromEmail: string;
  private readonly replyToEmail?: string;
  private readonly bccAddress?: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      throw new Error('Missing RESEND_API_KEY configuration');
    }

    this.resend = new Resend(apiKey);

    this.brandName = this.configService.get<string>('MAIL_BRAND_NAME') || 'Rifas';
    this.logoUrl =
      this.configService.get<string>('MAIL_LOGO_URL') ||
      'https://www.simonboli.com/assets/bolidos-Cwxz6QCE.png';

    this.fromEmail =
      this.configService.get<string>('MAIL_FROM') ||
      `"${this.brandName}" <no-reply@simonboli.com>`;

    this.replyToEmail =
      this.configService.get<string>('MAIL_REPLY_TO') || 'soporte@simonboli.com';

    this.bccAddress =
      this.configService.get<string>('MAIL_BCC_ADDRESS') ||
      process.env.MAIL_BCC_ADDRESS ||
      undefined;

    Handlebars.registerHelper('gt', (a: number, b: number) => a > b);
    Handlebars.registerHelper('year', () => new Date().getFullYear());
  }

  private formatDateEs(value: unknown): string {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('es-ES', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  private async renderTemplate(
    templateName: string,
    context: Record<string, unknown>,
  ): Promise<string> {
    const filePath = path.join(__dirname, 'templates', `${templateName}.hbs`);
    const source = await readFile(filePath, 'utf8');
    const template = Handlebars.compile(source, { strict: true });
    return template(context);
  }

  private async sendEmail(options: {
    to: string;
    subject: string;
    html: string;
  }): Promise<void> {
    const { data, error } = await this.resend.emails.send({
      from: this.fromEmail,
      to: options.to,
      subject: options.subject,
      html: options.html,
      replyTo: this.replyToEmail,
      bcc: this.bccAddress ? [this.bccAddress] : undefined,
    });

    if (error) {
      throw new Error(
        `Resend error: ${typeof error === 'string' ? error : JSON.stringify(error)}`,
      );
    }

    this.logger.log(
      `Email sent via Resend (id=${data?.id ?? 'unknown'}) to ${options.to}`,
    );
  }

  async sendPurchaseCreated(purchase: Purchase, customer: Customer) {
    try {
      const context: PurchaseEmailTemplateContext = {
        brandName: this.brandName,
        logoUrl: this.logoUrl,
        customer: {
          fullName: customer.fullName,
          email: customer.email,
        },
        purchase: {
          ticketNumbers: purchase.ticketNumbers || [],
          totalAmount: purchase.totalAmount,
          bankReference: purchase.bankReference,
          ticketQuantity: purchase.ticketQuantity,
          submittedAt: this.formatDateEs(purchase.submittedAt),
        },
        raffle: purchase.raffle
          ? {
              title: purchase.raffle.title,
              description: purchase.raffle.description,
            }
          : null,
      };

      const html = await this.renderTemplate(
        'purchase-created',
        context as unknown as Record<string, unknown>,
      );

      await this.sendEmail({
        to: customer.email,
        subject: `Confirmación de Recepción de Pago - ${this.brandName}`,
        html,
      });
    } catch (error) {
      this.logger.error(
        `Failed to send purchase created email to ${customer.email}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  async sendPurchaseVerified(purchase: Purchase, customer: Customer) {
    try {
      const context: PurchaseEmailTemplateContext = {
        brandName: this.brandName,
        logoUrl: this.logoUrl,
        customer: {
          fullName: customer.fullName,
          email: customer.email,
        },
        purchase: {
          ticketNumbers: purchase.ticketNumbers || [],
          totalAmount: purchase.totalAmount,
          bankReference: purchase.bankReference,
          ticketQuantity: purchase.ticketQuantity,
          verifiedAt: this.formatDateEs(purchase.verifiedAt),
        },
        raffle: purchase.raffle
          ? {
              title: purchase.raffle.title,
              description: purchase.raffle.description,
            }
          : null,
      };

      const html = await this.renderTemplate(
        'purchase-verified',
        context as unknown as Record<string, unknown>,
      );

      await this.sendEmail({
        to: customer.email,
        subject: `¡Compra Verificada! - ${this.brandName}`,
        html,
      });
    } catch (error) {
      this.logger.error(
        `Failed to send purchase verified email to ${customer.email}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  async sendPurchaseRejected(purchase: Purchase, customer: Customer) {
    try {
      const context: PurchaseEmailTemplateContext = {
        brandName: this.brandName,
        logoUrl: this.logoUrl,
        customer: {
          fullName: customer.fullName,
          email: customer.email,
        },
        purchase: {
          ticketNumbers: purchase.ticketNumbers || [],
          totalAmount: purchase.totalAmount,
          bankReference: purchase.bankReference,
          ticketQuantity: purchase.ticketQuantity,
          notes: purchase.notes || 'No se proporcionó un motivo específico.',
          submittedAt: this.formatDateEs(purchase.submittedAt),
        },
        raffle: purchase.raffle
          ? {
              title: purchase.raffle.title,
              description: purchase.raffle.description,
            }
          : null,
      };

      const html = await this.renderTemplate(
        'purchase-rejected',
        context as unknown as Record<string, unknown>,
      );

      await this.sendEmail({
        to: customer.email,
        subject: `Notificación sobre tu Compra - ${this.brandName}`,
        html,
      });
    } catch (error) {
      this.logger.error(
        `Failed to send purchase rejected email to ${customer.email}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }
}
