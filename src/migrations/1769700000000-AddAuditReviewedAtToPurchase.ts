import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddAuditReviewedAtToPurchase1769700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'purchase',
      new TableColumn({
        name: 'audit_reviewed_at',
        type: 'timestamp',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('purchase', 'audit_reviewed_at');
  }
}
