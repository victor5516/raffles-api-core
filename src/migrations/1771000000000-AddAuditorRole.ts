import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAuditorRole1771000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "admin_role_enum" ADD VALUE IF NOT EXISTS 'auditor';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing a value from an enum easily.
    // Document that this migration's down does not revert the enum value.
  }
}
