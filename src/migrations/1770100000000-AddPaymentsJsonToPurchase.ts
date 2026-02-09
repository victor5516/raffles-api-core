import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddPaymentsJsonToPurchase1770100000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add 'payments' JSONB column
    await queryRunner.addColumn(
      'purchase',
      new TableColumn({
        name: 'payments',
        type: 'jsonb',
        default: "'[]'",
        isNullable: false,
      }),
    );

    // 2. Add 'total_paid' numeric column
    await queryRunner.addColumn(
      'purchase',
      new TableColumn({
        name: 'total_paid',
        type: 'numeric',
        precision: 10,
        scale: 2,
        default: 0,
        isNullable: false,
      }),
    );

    // 3. Migrate existing data: populate payments[] from flat columns
    //    JOIN through payment_method -> currency to get the symbol
    await queryRunner.query(`
      UPDATE purchase p
      SET payments = jsonb_build_array(
          jsonb_build_object(
              'amount', p.total_amount,
              'reference', p.bank_reference,
              'currency', COALESCE(c.symbol, ''),
              'evidenceUrl', p.payment_screenshot_url,
              'verified', (p.status = 'verified'),
              'paymentMethodId', pm.uid,
              'paymentMethodName', pm.name
          )
      ),
      total_paid = p.total_amount
      FROM payment_method pm
      LEFT JOIN currency c ON c.uid = pm.currency_id
      WHERE pm.uid = p.payment_method_id
        AND p.bank_reference IS NOT NULL
        AND (p.payments = '[]'::jsonb);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('purchase', 'total_paid');
    await queryRunner.dropColumn('purchase', 'payments');
  }
}
