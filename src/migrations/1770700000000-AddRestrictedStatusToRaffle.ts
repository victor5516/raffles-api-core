import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRestrictedStatusToRaffle1770700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // TypeORM default: enum for column 'status' in table 'raffle' is 'raffle_status_enum'
    await queryRunner.query(
      `ALTER TYPE "public"."raffle_status_enum" ADD VALUE IF NOT EXISTS 'restricted'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Removing an enum value is not directly supported by Postgres and requires type recreation.
  }
}
