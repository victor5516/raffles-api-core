import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServeStaticModule } from '@nestjs/serve-static';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { join } from 'path';
import databaseConfig from './config/database.config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { RafflesModule } from './modules/raffles/raffles.module';
import { PaymentMethodsModule } from './modules/payments/payment-methods.module';
import { CurrenciesModule } from './modules/currencies/currencies.module';
import { PurchasesModule } from './modules/purchases/purchases.module';
import { CustomersModule } from './modules/customers/customers.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { S3Module } from './common/s3/s3.module';
import { SqsModule } from './common/sqs/sqs.module';
// import { MailModule } from './modules/mail/mail.module'; // Deshabilitado: SES no funciona

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig],
    }),
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        configService.getOrThrow('database'),
    }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
    }),
    S3Module,
    SqsModule,
    // MailModule, // Deshabilitado: SES no funciona
    AuthModule,
    RafflesModule,
    PaymentMethodsModule,
    CurrenciesModule,
    PurchasesModule,
    CustomersModule,
    TicketsModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
