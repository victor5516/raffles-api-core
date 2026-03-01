import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddSpreadsheetIdToRaffle1770500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'raffle',
      new TableColumn({
        name: 'spreadsheet_id',
        type: 'varchar',
        isNullable: true,
      }),
    );

    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (spreadsheetId) {
      await queryRunner.query(
        `UPDATE "raffle" SET "spreadsheet_id" = $1 WHERE "spreadsheet_id" IS NULL`,
        [spreadsheetId],
      );

      await queryRunner.query(
        `ALTER TABLE "raffle" ALTER COLUMN "spreadsheet_id" SET NOT NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('raffle', 'spreadsheet_id');
  }
}
