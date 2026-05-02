import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddShowTopBuyersToRaffle1771400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'raffle',
      new TableColumn({
        name: 'show_top_buyers',
        type: 'boolean',
        default: false,
        isNullable: false,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('raffle', 'show_top_buyers');
  }
}
