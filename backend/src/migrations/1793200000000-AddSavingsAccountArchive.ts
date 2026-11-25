import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddSavingsAccountArchive1793200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('savings_accounts', [
      new TableColumn({
        name: 'archived_at',
        type: 'timestamptz',
        isNullable: true,
      }),
      new TableColumn({
        name: 'merged_into',
        type: 'varchar',
        isNullable: true,
      }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns('savings_accounts', [
      'archived_at',
      'merged_into',
    ]);
  }
}
