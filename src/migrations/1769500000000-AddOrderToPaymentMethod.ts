import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddOrderToPaymentMethod1769500000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'payment_method',
      new TableColumn({
        name: 'order',
        type: 'int',
        isNullable: false,
        default: 0,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('payment_method', 'order');
  }
}

