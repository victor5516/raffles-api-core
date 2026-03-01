import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCouponTable1770800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "coupon" (
        "code"           VARCHAR(6) NOT NULL,
        "is_active"      BOOLEAN    NOT NULL DEFAULT true,
        "expires_at"     TIMESTAMP  NOT NULL,
        "redeemed_at"    TIMESTAMP,
        "purchase_id"    UUID,
        "created_by_id"  UUID       NOT NULL,
        "created_at"     TIMESTAMP  NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coupon_code" PRIMARY KEY ("code"),
        CONSTRAINT "FK_coupon_purchase"
          FOREIGN KEY ("purchase_id") REFERENCES "purchase"("uid") ON DELETE SET NULL,
        CONSTRAINT "FK_coupon_admin"
          FOREIGN KEY ("created_by_id") REFERENCES "admin"("uid") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_coupon_is_active_expires_at"
        ON "coupon" ("is_active", "expires_at")
        WHERE "redeemed_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_coupon_purchase_id"
        ON "coupon" ("purchase_id")
        WHERE "purchase_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "coupon"`);
  }
}
