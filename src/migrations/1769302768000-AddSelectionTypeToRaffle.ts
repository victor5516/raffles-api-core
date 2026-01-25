import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSelectionTypeToRaffle1769302768000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum type
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "raffle_selection_type_enum" AS ENUM ('random', 'specific');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // Add column with default value
    await queryRunner.query(`
      ALTER TABLE "raffle"
      ADD COLUMN "selection_type" "raffle_selection_type_enum" NOT NULL DEFAULT 'random';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove column
    await queryRunner.query(`
      ALTER TABLE "raffle"
      DROP COLUMN "selection_type";
    `);

    // Drop enum type (only if no other columns use it)
    await queryRunner.query(`
      DROP TYPE IF EXISTS "raffle_selection_type_enum";
    `);
  }
}
