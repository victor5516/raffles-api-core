import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddExportedToSheetsToPurchase1770000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'purchase',
      new TableColumn({
        name: 'exported_to_sheets',
        type: 'boolean',
        default: false,
        isNullable: false,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('purchase', 'exported_to_sheets');
  }
}
