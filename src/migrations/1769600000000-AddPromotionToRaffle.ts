import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddPromotionToRaffle1769600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'raffle',
      new TableColumn({
        name: 'promotion_strategy',
        type: 'varchar',
        isNullable: true,
      }),
    );
    await queryRunner.addColumn(
      'raffle',
      new TableColumn({
        name: 'promotion_config',
        type: 'jsonb',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('raffle', 'promotion_config');
    await queryRunner.dropColumn('raffle', 'promotion_strategy');
  }
}
