import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds membership-listing columns to the `groups` table created by
 * `CreateGroups1778500000000` (for `group_split_settled` projection):
 * `creator`, `name`, `members`, and `open`.
 *
 * These support `GET /savings/groups?address=`, which filters groups by
 * `WHERE :address = ANY(members)` — backed by the GIN index created below
 * (a plain btree index would not support that access pattern efficiently).
 * `creator`/`name` are nullable because a group projected only from
 * `group_split_settled` (via `GroupsService.markSettled`) may not yet have
 * seen a `group_created` event with that data.
 */
export class AddMembershipFieldsToGroups1778700000000 implements MigrationInterface {
  name = 'AddMembershipFieldsToGroups1778700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('groups', [
      new TableColumn({
        name: 'creator',
        type: 'varchar',
        isNullable: true,
      }),
      new TableColumn({
        name: 'name',
        type: 'varchar',
        isNullable: true,
      }),
      new TableColumn({
        name: 'members',
        type: 'text',
        isArray: true,
        default: "'{}'",
        isNullable: false,
      }),
      new TableColumn({
        name: 'open',
        type: 'boolean',
        default: true,
        isNullable: false,
      }),
    ]);

    // GIN index to support `WHERE :address = ANY(members)` membership
    // lookups (see GET /savings/groups?address=).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_groups_members"
        ON "groups" USING GIN ("members")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_groups_members"`);
    await queryRunner.dropColumn('groups', 'open');
    await queryRunner.dropColumn('groups', 'members');
    await queryRunner.dropColumn('groups', 'name');
    await queryRunner.dropColumn('groups', 'creator');
  }
}
