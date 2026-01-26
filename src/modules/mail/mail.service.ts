import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { ConfigService } from '@nestjs/config';
import { Purchase } from '../purchases/entities/purchase.entity';
import { Customer } from '../customers/entities/customer.entity';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly brandName: string;

  constructor(
    private readonly mailerService: MailerService,
    private readonly configService: ConfigService,
  ) {
    this.brandName =
      this.configService.get<string>('MAIL_BRAND_NAME') || 'Rifas';
  }

  async sendPurchaseCreated(purchase: Purchase, customer: Customer) {
    try {
      const bccAddress = process.env.MAIL_BCC_ADDRESS;
      const mailOptions: any = {
        to: customer.email,
        subject: `Confirmación de Recepción de Pago - ${this.brandName}`,
        template: 'purchase-created',
        context: {
          brandName: this.brandName,
          customer: {
            fullName: customer.fullName,
            email: customer.email,
          },
          purchase: {
            ticketNumbers: purchase.ticketNumbers || [],
            totalAmount: purchase.totalAmount,
            bankReference: purchase.bankReference,
            ticketQuantity: purchase.ticketQuantity,
            submittedAt: purchase.submittedAt
              ? new Date(purchase.submittedAt).toLocaleDateString('es-ES', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })
              : '',
          },
          raffle: purchase.raffle
            ? {
                title: purchase.raffle.title,
                description: purchase.raffle.description,
              }
            : null,
        },
      };

      if (bccAddress) {
        mailOptions.bcc = bccAddress;
      }

      await this.mailerService.sendMail(mailOptions);
      this.logger.log(`Purchase created email sent to ${customer.email}`);
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
      const bccAddress = process.env.MAIL_BCC_ADDRESS;
      const mailOptions: any = {
        to: customer.email,
        subject: `¡Compra Verificada! - ${this.brandName}`,
        template: 'purchase-verified',
        context: {
          brandName: this.brandName,
          customer: {
            fullName: customer.fullName,
            email: customer.email,
          },
          purchase: {
            ticketNumbers: purchase.ticketNumbers || [],
            totalAmount: purchase.totalAmount,
            bankReference: purchase.bankReference,
            ticketQuantity: purchase.ticketQuantity,
            verifiedAt: purchase.verifiedAt
              ? new Date(purchase.verifiedAt).toLocaleDateString('es-ES', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })
              : '',
          },
          raffle: purchase.raffle
            ? {
                title: purchase.raffle.title,
                description: purchase.raffle.description,
              }
            : null,
        },
      };

      if (bccAddress) {
        mailOptions.bcc = bccAddress;
      }

      await this.mailerService.sendMail(mailOptions);
      this.logger.log(`Purchase verified email sent to ${customer.email}`);
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
      const bccAddress = process.env.MAIL_BCC_ADDRESS;
      const mailOptions: any = {
        to: customer.email,
        subject: `Notificación sobre tu Compra - ${this.brandName}`,
        template: 'purchase-rejected',
        context: {
          brandName: this.brandName,
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
            submittedAt: purchase.submittedAt
              ? new Date(purchase.submittedAt).toLocaleDateString('es-ES', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })
              : '',
          },
          raffle: purchase.raffle
            ? {
                title: purchase.raffle.title,
                description: purchase.raffle.description,
              }
            : null,
        },
      };

      if (bccAddress) {
        mailOptions.bcc = bccAddress;
      }

      await this.mailerService.sendMail(mailOptions);
      this.logger.log(`Purchase rejected email sent to ${customer.email}`);
    } catch (error) {
      this.logger.error(
        `Failed to send purchase rejected email to ${customer.email}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }
}
