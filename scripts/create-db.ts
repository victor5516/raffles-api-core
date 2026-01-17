import { Client } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

async function createDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not defined in .env');
    process.exit(1);
  }

  // Parse DATABASE_URL to get connection details for the 'postgres' default database
  const url = new URL(databaseUrl);
  const dbName = url.pathname.split('/')[1];
  if (!dbName) {
    console.error('DATABASE_URL must include a database name in the path, e.g. postgresql://user:pass@host:5432/mydb');
    process.exit(1);
  }

  // Connect to default 'postgres' database to create the new one
  url.pathname = '/postgres';

  const shouldUseSsl =
    process.env.DATABASE_SSL === 'true' ||
    (process.env.PGSSLMODE?.toLowerCase() === 'require') ||
    url.searchParams.get('sslmode') === 'require' ||
    url.searchParams.get('ssl') === 'true' ||
    url.hostname.endsWith('.rds.amazonaws.com');

  const client = new Client({
    connectionString: url.toString(),
    ...(shouldUseSsl
      ? {
          // Note: If you want strict verification, set DATABASE_SSL_REJECT_UNAUTHORIZED=true
          // and provide the AWS RDS CA bundle via NODE_EXTRA_CA_CERTS or ssl.ca.
          ssl: {
            rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true',
          },
        }
      : {}),
  });

  try {
    await client.connect();

    // Check if database exists
    const res = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );

    if (res.rowCount === 0) {
      console.log(`Creating database "${dbName}"...`);
      // CREATE DATABASE cannot run in a transaction block, so we run it directly
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Database "${dbName}" created successfully.`);
    } else {
      console.log(`Database "${dbName}" already exists.`);
    }
  } catch (error) {
    console.error('Error creating database:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

createDatabase();
