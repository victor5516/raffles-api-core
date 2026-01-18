import 'reflect-metadata';
import { DataSource } from 'typeorm';

const parseBool = (v: string | undefined): boolean | undefined => {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
  return undefined;
};

const isProd = process.env.NODE_ENV === 'production';

// IMPORTANT:
// - Keep synchronize=false when using migrations.
// - Use TypeORM CLI to generate/run migrations.
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../migrations/*{.ts,.js}'],
  synchronize: false,
  logging: parseBool(process.env.DATABASE_LOGGING) ?? !isProd,
  ...(isProd
    ? {
        ssl: {
          rejectUnauthorized:
            process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true',
        },
      }
    : {}),
});

export default AppDataSource;

