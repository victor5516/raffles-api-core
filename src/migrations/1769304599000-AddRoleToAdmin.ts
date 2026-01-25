import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRoleToAdmin1769304599000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum type
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "admin_role_enum" AS ENUM ('super_admin', 'verifier');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // Add column with default value
    await queryRunner.query(`
      ALTER TABLE "admin"
      ADD COLUMN "role" "admin_role_enum" NOT NULL DEFAULT 'verifier';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove column
    await queryRunner.query(`
      ALTER TABLE "admin"
      DROP COLUMN "role";
    `);

    // Drop enum type (only if no other columns use it)
    await queryRunner.query(`
      DROP TYPE IF EXISTS "admin_role_enum";
    `);
  }
}
