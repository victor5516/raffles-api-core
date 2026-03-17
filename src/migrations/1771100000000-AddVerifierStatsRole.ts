import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVerifierStatsRole1771100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "admin_role_enum" ADD VALUE IF NOT EXISTS 'verifier_stats';
    `);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- empty down: PG enum value cannot be removed
  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing a value from an enum easily.
    // Document that this migration's down does not revert the enum value.
  }
}
