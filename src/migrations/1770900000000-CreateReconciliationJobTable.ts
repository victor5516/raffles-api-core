import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReconciliationJobTable1770900000000
  implements MigrationInterface
{
  name = 'CreateReconciliationJobTable1770900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."reconciliation_jobs_status_enum"
        AS ENUM ('processing', 'ready', 'failed')
    `);

    await queryRunner.query(`
      CREATE TABLE "reconciliation_jobs" (
        "uid"               UUID        NOT NULL,
        "raffle_id"         VARCHAR     NOT NULL,
        "payment_method_id" VARCHAR     NOT NULL,
        "file_name"         VARCHAR,
        "file_mime_type"    VARCHAR,
        "status"            "public"."reconciliation_jobs_status_enum"
                              NOT NULL DEFAULT 'processing',
        "result"            jsonb,
        "error_message"     text,
        "created_by"        VARCHAR,
        "started_at"        TIMESTAMP,
        "completed_at"      TIMESTAMP,
        "created_at"        TIMESTAMP   NOT NULL DEFAULT now(),
        "updated_at"        TIMESTAMP   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reconciliation_jobs" PRIMARY KEY ("uid")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_reconciliation_jobs_raffle_id"
        ON "reconciliation_jobs" ("raffle_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_reconciliation_jobs_status"
        ON "reconciliation_jobs" ("status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "reconciliation_jobs"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."reconciliation_jobs_status_enum"`,
    );
  }
}
