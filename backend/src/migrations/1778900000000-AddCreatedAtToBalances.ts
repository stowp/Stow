import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds `created_at` to `balances` so GET /savings/accounts/:address can
 * report when a flexible account was first observed, alongside its
 * existing `updated_at`.
 */
export class AddCreatedAtToBalances1778900000000 implements MigrationInterface {
  name = 'AddCreatedAtToBalances1778900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'balances',
      new TableColumn({
        name: 'created_at',
        type: 'timestamp',
        default: 'now()',
        isNullable: false,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('balances', 'created_at');
  }
}
