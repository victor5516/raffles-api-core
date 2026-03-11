import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddRequiredFieldsAndMetadata1771100000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'payment_method',
      new TableColumn({
        name: 'required_fields',
        type: 'jsonb',
        isNullable: true,
      }),
    );
    await queryRunner.addColumn(
      'purchase',
      new TableColumn({
        name: 'metadata',
        type: 'jsonb',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('payment_method', 'required_fields');
    await queryRunner.dropColumn('purchase', 'metadata');
  }
}
