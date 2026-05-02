import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSpinsTables1771300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."spin_prize_type_enum" AS ENUM('COUPON', 'FREE_TICKET', 'NOTHING')
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."spin_token_source_enum" AS ENUM('PROMO_LINK', 'PURCHASE_REWARD')
    `);

    await queryRunner.query(`
      CREATE TABLE "spin_prize" (
        "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying(120) NOT NULL,
        "type" "public"."spin_prize_type_enum" NOT NULL,
        "weight" integer NOT NULL,
        "inventory" integer,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_spin_prize_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "spin_token" (
        "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "customer_id" UUID,
        "source" "public"."spin_token_source_enum" NOT NULL,
        "source_reference" character varying(120),
        "is_used" boolean NOT NULL DEFAULT false,
        "expires_at" TIMESTAMPTZ,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_spin_token_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_spin_token_customer_id"
          FOREIGN KEY ("customer_id") REFERENCES "customer"("uid") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "spin_result" (
        "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
        "spin_token_id" UUID NOT NULL,
        "prize_id" UUID NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_spin_result_spin_token_id" UNIQUE ("spin_token_id"),
        CONSTRAINT "PK_spin_result_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_spin_result_spin_token_id"
          FOREIGN KEY ("spin_token_id") REFERENCES "spin_token"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_spin_result_prize_id"
          FOREIGN KEY ("prize_id") REFERENCES "spin_prize"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_spin_token_customer_id_is_used"
        ON "spin_token" ("customer_id", "is_used")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_spin_prize_is_active"
        ON "spin_prize" ("is_active")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_spin_token_purchase_reward_source_reference"
        ON "spin_token" ("source", "source_reference")
        WHERE "source_reference" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_spin_token_purchase_reward_source_reference"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_spin_prize_is_active"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_spin_token_customer_id_is_used"`,
    );
    await queryRunner.query(`DROP TABLE "spin_result"`);
    await queryRunner.query(`DROP TABLE "spin_token"`);
    await queryRunner.query(`DROP TABLE "spin_prize"`);
    await queryRunner.query(`DROP TYPE "public"."spin_token_source_enum"`);
    await queryRunner.query(`DROP TYPE "public"."spin_prize_type_enum"`);
  }
}
