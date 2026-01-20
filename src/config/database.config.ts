import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export default registerAs(
  'database',
  (): TypeOrmModuleOptions => {
    const isProd = process.env.NODE_ENV === 'production';
    const rejectUnauthorized =
      process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true';

    return {
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [__dirname + '/../**/*.entity{.ts,.js}'],
      synchronize: true, // Don't use true in production!
      logging: true,
      ...(true
        ? {
            ssl: {
              rejectUnauthorized,
            },
          }
        : {}),
    };
  },
);
