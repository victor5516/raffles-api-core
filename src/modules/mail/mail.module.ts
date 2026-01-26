import { Module } from '@nestjs/common';
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
        const region = configService.get<string>('AWS_REGION') || 'us-east-1';

        // Create SESv2 client - will use IAM role credentials automatically on EC2
        const sesClient = new SESv2Client({ region });

        // Create nodemailer transport with SES
        // Note: nodemailer requires @aws-sdk/client-sesv2 (not client-ses)
        const transporter = nodemailer.createTransport({
          SES: { sesClient, SendEmailCommand },
        } as any);

        const brandName =
          configService.get<string>('MAIL_BRAND_NAME') || 'Rifas';
        const mailFrom =
          configService.get<string>('MAIL_FROM') ||
          `"${brandName}" <no-reply@simonboli.com>`;

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
