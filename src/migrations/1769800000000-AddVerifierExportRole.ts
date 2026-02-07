import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVerifierExportRole1769800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "admin_role_enum" ADD VALUE IF NOT EXISTS 'verifier_export';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing a value from an enum easily.
    // Document that this migration's down does not revert the enum value.
  }
}
