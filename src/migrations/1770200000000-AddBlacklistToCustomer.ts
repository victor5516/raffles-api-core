import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddBlacklistToCustomer1770200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'customer',
      new TableColumn({
        name: 'is_blacklisted',
        type: 'boolean',
        default: false,
        isNullable: false,
      }),
    );

    await queryRunner.addColumn(
      'customer',
      new TableColumn({
        name: 'blacklist_reason',
        type: 'varchar',
        isNullable: true,
      }),
    );

    await queryRunner.addColumn(
      'customer',
      new TableColumn({
        name: 'blacklisted_at',
        type: 'timestamptz',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('customer', 'blacklisted_at');
    await queryRunner.dropColumn('customer', 'blacklist_reason');
    await queryRunner.dropColumn('customer', 'is_blacklisted');
  }
}
