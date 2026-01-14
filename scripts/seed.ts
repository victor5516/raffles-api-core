import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcrypt';
import { Admin } from '../src/modules/auth/entities/admin.entity';
import { Currency } from '../src/modules/currencies/entities/currency.entity';
import databaseConfig from '../src/config/database.config';
import { ConfigService } from '@nestjs/config';

dotenv.config();

// We need a way to get the TypeORM config without the full NestJS app if possible,
// or manually construct it.
// Reusing the config factory logic:
const config = (databaseConfig as any)();

const dataSource = new DataSource({
  ...config,
});

async function seed() {
  try {
    console.log('Connecting to database...');
    await dataSource.initialize();

    // Seed Currencies
    const currencyRepo = dataSource.getRepository(Currency);
    const currencies = [
      { name: 'Bolívar', symbol: 'VES', value: 1 },
      { name: 'Dólar Estadounidense', symbol: 'USD', value: 1 },
    ];

    for (const c of currencies) {
      const exists = await currencyRepo.findOne({ where: { symbol: c.symbol } });
      if (!exists) {
        await currencyRepo.save(currencyRepo.create(c));
        console.log(`Created currency: ${c.name}`);
      } else {
        console.log(`Currency ${c.name} already exists.`);
      }
    }

    // Seed Admin
    const adminRepo = dataSource.getRepository(Admin);
    const args = process.argv.slice(2);

    if (args.length >= 3) {
      const [email, password, fullName] = args;
      const exists = await adminRepo.findOne({ where: { email } });

      if (!exists) {
        const passwordHash = await bcrypt.hash(password, 10);
        await adminRepo.save(adminRepo.create({
          email,
          passwordHash,
          fullName
        }));
        console.log(`Created admin: ${email}`);
      } else {
        console.log(`Admin ${email} already exists.`);
      }
    } else {
       console.log('No admin arguments provided. Usage: npm run db:seed -- <email> <password> <full_name>');
       console.log('Skipping admin creation.');
    }

  } catch (error) {
    console.error('Error seeding database:', error);
    process.exit(1);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

seed();
