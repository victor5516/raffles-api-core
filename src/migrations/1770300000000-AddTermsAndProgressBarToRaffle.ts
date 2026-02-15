import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddTermsAndProgressBarToRaffle1770300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'raffle',
      new TableColumn({
        name: 'terms_and_conditions',
        type: 'text',
        isNullable: true,
      }),
    );

    await queryRunner.addColumn(
      'raffle',
      new TableColumn({
        name: 'show_progress_bar',
        type: 'boolean',
        default: false,
        isNullable: false,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('raffle', 'show_progress_bar');
    await queryRunner.dropColumn('raffle', 'terms_and_conditions');
  }
}
