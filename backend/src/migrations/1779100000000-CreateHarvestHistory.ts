import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Creates the `harvest_history` table projected by the indexer from the
 * yield-adapter contract's `harvested` events.
 */
export class CreateHarvestHistory1779100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'harvest_history',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'delta',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'fee',
            type: 'varchar',
            default: "'0'",
            isNullable: false,
          },
          {
            name: 'harvested_at',
            type: 'timestamptz',
            isNullable: false,
          },
          {
            name: 'ledger',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'tx_hash',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'now()',
            isNullable: false,
          },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('harvest_history', true);
  }
}
