import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddAccountHolderNameToPaymentMethod1769304600000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'payment_method',
      new TableColumn({
        name: 'account_holder_name',
        type: 'varchar',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('payment_method', 'account_holder_name');
  }
}
