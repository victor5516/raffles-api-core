import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDuplicatedStatus1768867200000 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // We use the default naming convention for the enum.
        // If the enum name is different, this might fail.
        // Assuming 'purchase_status_enum' based on column name 'status' in 'purchase' table.
        await queryRunner.query(`ALTER TYPE "public"."purchase_status_enum" ADD VALUE IF NOT EXISTS 'duplicated'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Removing an enum value is not directly supported by Postgres and requires type recreation.
    }
}
