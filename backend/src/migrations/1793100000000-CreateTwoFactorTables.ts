import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
} from 'typeorm';

export class CreateTwoFactorTables1793100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'two_factor_auth',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
          },
          { name: 'userId', type: 'uuid', isNullable: false },
          { name: 'secret', type: 'varchar', isNullable: true },
          { name: 'isEnabled', type: 'boolean', default: false },
          { name: 'isVerified', type: 'boolean', default: false },
          { name: 'backupCodes', type: 'text', isNullable: true },
          { name: 'lastUsedAt', type: 'timestamp', isNullable: true },
          { name: 'failedAttempts', type: 'int', default: 0 },
          { name: 'lockedUntil', type: 'timestamp', isNullable: true },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'now()',
          },
          {
            name: 'updatedAt',
            type: 'timestamp',
            default: 'now()',
          },
        ],
      }),
      true,
    );
    await queryRunner.createForeignKey(
      'two_factor_auth',
      new TableForeignKey({
        name: 'FK_two_factor_auth_user',
        columnNames: ['userId'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'two_factor_recovery',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
          },
          { name: 'userId', type: 'uuid', isNullable: false },
          { name: 'recoveryToken', type: 'varchar', isNullable: false },
          { name: 'expiresAt', type: 'timestamp', isNullable: false },
          { name: 'isUsed', type: 'boolean', default: false },
          { name: 'usedAt', type: 'timestamp', isNullable: true },
          { name: 'ipAddress', type: 'varchar', isNullable: true },
          { name: 'userAgent', type: 'varchar', isNullable: true },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'now()',
          },
        ],
      }),
      true,
    );
    await queryRunner.createForeignKey(
      'two_factor_recovery',
      new TableForeignKey({
        name: 'FK_two_factor_recovery_user',
        columnNames: ['userId'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('two_factor_recovery', true);
    await queryRunner.dropTable('two_factor_auth', true);
  }
}
