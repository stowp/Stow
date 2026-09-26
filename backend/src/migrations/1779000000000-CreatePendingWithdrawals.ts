import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Creates the `pending_withdrawals` read-model table projected by the
 * indexer from the yield-adapter contract's `withdraw_requested` and
 * `withdraw_cancelled` events.
 */
export class CreatePendingWithdrawals1779000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'pending_withdrawals',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'request_id',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'owner',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'shares',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'claimable_at',
            type: 'timestamptz',
            isNullable: false,
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['pending', 'claimed', 'cancelled'],
            default: "'pending'",
            isNullable: false,
          },
          {
            name: 'cancelled_at',
            type: 'timestamptz',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'now()',
            isNullable: false,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'now()',
            isNullable: false,
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'pending_withdrawals',
      new TableIndex({
        name: 'UQ_pending_withdrawals_request_id',
        columnNames: ['request_id'],
        isUnique: true,
      }),
    );

    await queryRunner.createIndex(
      'pending_withdrawals',
      new TableIndex({
        name: 'IDX_pending_withdrawals_status',
        columnNames: ['status'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('pending_withdrawals', true);
  }
}
