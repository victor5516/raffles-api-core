import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddSheetNameToPaymentMethod1770400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'payment_method',
      new TableColumn({
        name: 'sheet_name',
        type: 'varchar',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('payment_method', 'sheet_name');
  }
}
