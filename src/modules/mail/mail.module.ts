import { Module, Logger } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter';
import { ConfigModule, ConfigService } from '@nestjs/config';
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

        logger.log(`Initializing SES client for region: ${region}`);

        // Create SESv2 client - will use IAM role credentials automatically on EC2
        // If credentials are not available via IAM role, AWS SDK will use:
        // 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
        // 2. Shared credentials file (~/.aws/credentials)
        // 3. IAM role (on EC2)
        const sesClient = new SESv2Client({
          region,
          // Let AWS SDK use default credential chain
        });

        // Create nodemailer transport with SES
        // Note: The SES object must have exactly 'sesClient' and 'SendEmailCommand' properties
        // Property names must match exactly as nodemailer expects them
        const sesConfig = {
          SES: {
            sesClient,
            SendEmailCommand
          },
        };

        // Create the transport - this must be a nodemailer transport instance
        const transporter = nodemailer.createTransport(sesConfig as any);

        // Verify the transport was created correctly (should be SES transport, not SMTP)
        const transportName = transporter.transporter?.name || 'unknown';
        logger.log(`Transport created. Type: ${transportName}`);

        if (transportName !== 'SES' && transportName !== 'ses') {
          const errorMsg = `CRITICAL: Expected SES transport but got ${transportName}. The transport may fall back to SMTP.`;
          logger.error(errorMsg);
          throw new Error(errorMsg);
        }

        logger.log('SES transport verified successfully');

        const brandName =
          configService.get<string>('MAIL_BRAND_NAME') || 'Rifas';
        const mailFrom =
          configService.get<string>('MAIL_FROM') ||
          `"${brandName}" <no-reply@simonboli.com>`;

        logger.log(`Mail configured with from: ${mailFrom}`);

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
