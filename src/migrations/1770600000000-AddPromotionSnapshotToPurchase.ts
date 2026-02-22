import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddPromotionSnapshotToPurchase1770600000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'purchase',
      new TableColumn({
        name: 'promotion_snapshot',
        type: 'jsonb',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('purchase', 'promotion_snapshot');
  }
}
