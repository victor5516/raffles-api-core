import { Module } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as aws from '@aws-sdk/client-ses';
import * as nodemailer from 'nodemailer';
import { MailService } from './mail.service';

@Module({
  imports: [
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const region = configService.get<string>('AWS_REGION') || 'us-east-1';

        // 1. Cliente SES (AWS SDK v3)
        const ses = new aws.SES({
          region,
        });

        // 2. Transportador con el truco para TypeScript
        const transporter = nodemailer.createTransport({
          SES: ses,
        } as any); // <--- ¡AQUÍ ESTÁ LA CLAVE! (as any)

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