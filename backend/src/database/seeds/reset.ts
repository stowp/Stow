import { DataSource, QueryRunner } from 'typeorm';
import { config } from 'dotenv';

config();

/**
 * Database reset script
 *
 * Truncates the current Stow savings schema's seeded tables so the database
 * can be re-seeded from a clean slate. This intentionally does NOT drop
 * tables/run migrations — schema management stays with
 * `migration:run`/`migration:revert`; this script only clears data.
 *
 * Guarded against production: refuses to run when NODE_ENV === 'production',
 * matching the same guard `seed.ts` uses, since truncating these tables is
 * destructive and this script is a dev/test convenience only.
 */

/**
 * Tables seeded by `seed.ts`, in an order that lists tables with foreign-key
 * references (`group_members` -> `groups`) before the tables they
 * reference. `TRUNCATE ... CASCADE` also cascades to dependent rows
 * regardless of order, so this ordering is belt-and-suspenders rather than
 * load-bearing.
 *
 * Deliberately scoped to the current savings schema only — earlier versions
 * of this script targeted a prediction-market schema
 * (`events`/`matches`/`predictions`/...) that no longer has corresponding
 * entities (see the `DropLegacyPredictionMarketTables` migration), and it
 * also truncated `verified_addresses`, a currently-active admin table
 * unrelated to savings seed data. Neither belongs here.
 */
export const SAVINGS_SEED_TABLES = [
  'group_members',
  'groups',
  'goals',
  'anchor_deposits',
  'locked_plans',
  'balances',
  'savings_accounts',
  'users',
] as const;

/**
 * Truncates a single table via the given query runner, logging success or a
 * non-fatal warning (e.g. the table doesn't exist yet because migrations
 * haven't run) rather than aborting the whole reset.
 */
export async function truncateTable(
  queryRunner: Pick<QueryRunner, 'query'>,
  table: string,
): Promise<void> {
  try {
    await queryRunner.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
    console.log(`✓ Truncated table: ${table}`);
  } catch {
    console.log(`⚠ Table ${table} does not exist or could not be truncated`);
  }
}

/** Throws-and-exits when run against a production environment. */
export function assertNotProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Cannot run database reset in production environment!');
    process.exit(1);
  }
}

assertNotProduction();

const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
  synchronize: false,
  logging: false,
});

async function reset() {
  try {
    await dataSource.initialize();
    console.log('Database connection established');

    const queryRunner = dataSource.createQueryRunner();

    console.log('Resetting database...');

    for (const table of SAVINGS_SEED_TABLES) {
      await truncateTable(queryRunner, table);
    }

    console.log('\n✅ Database reset completed!');
    console.log('Run "npm run seed" to populate seed data');
  } catch (error) {
    console.error('❌ Reset failed:', error);
    process.exit(1);
  } finally {
    await dataSource.destroy();
  }
}

void reset();
