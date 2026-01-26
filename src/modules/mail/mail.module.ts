import { Module, Logger } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter';
import { ConfigModule, ConfigService } from '@nestjs/config';
// IMPORTANTE: Usamos SESv2Client (Requerido por Nodemailer v7)
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import * as nodemailer from 'nodemailer';
import { MailService } from './mail.service';

@Module({
  imports: [
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const logger = new Logger('MailModule');
        const region = configService.get<string>('AWS_REGION') || 'us-east-1';

        logger.log(`Configuring SES V2 for region: ${region}`);

        // 1. Instancia del cliente SES V2
        const sesClient = new SESv2Client({
          region,
          // En EC2 usa IAM Role automáticamente.
          // En Local usa tus AWS_ACCESS_KEY_ID del .env
        });

        // 2. Transportador Nodemailer v7
        // Nodemailer v7 requiere un objeto con 'sesClient' y 'SendEmailCommand'
        const transporter = nodemailer.createTransport({
          SES: {
            sesClient,
            SendEmailCommand,
          },
        } as any);

        const brandName = configService.get<string>('MAIL_BRAND_NAME') || 'Rifas';
        const mailFrom = configService.get<string>('MAIL_FROM') || `"${brandName}" <no-reply@simonboli.com>`;

        return {
          transport: transporter,
          defaults: {
            from: mailFrom,
            replyTo: 'soporte@simonboli.com',
          },
          template: {
            dir: process.cwd() + '/dist/modules/mail/templates',
            adapter: new HandlebarsAdapter({
              gt: (a: number, b: number) => a > b,
              year: () => new Date().getFullYear(),
            } as any),
            options: {
              strict: true,
            },
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}