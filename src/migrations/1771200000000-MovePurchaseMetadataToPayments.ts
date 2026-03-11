import { MigrationInterface, QueryRunner } from 'typeorm';

export class MovePurchaseMetadataToPayments1771200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Backfill: move legacy purchase.metadata into payments[0].metadata
    await queryRunner.query(`
      UPDATE purchase
      SET payments = jsonb_set(payments, '{0,metadata}', metadata, true)
      WHERE metadata IS NOT NULL
        AND jsonb_typeof(payments) = 'array'
        AND jsonb_array_length(payments) > 0;
    `);

    // Drop legacy column
    await queryRunner.query(`
      ALTER TABLE purchase
      DROP COLUMN IF EXISTS metadata;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Recreate legacy column (no reverse backfill to avoid data loss surprises)
    await queryRunner.query(`
      ALTER TABLE purchase
      ADD COLUMN IF NOT EXISTS metadata jsonb;
    `);
  }
}

