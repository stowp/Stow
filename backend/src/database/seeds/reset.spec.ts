import { QueryRunner } from 'typeorm';
import type * as ResetModule from './reset';

/**
 * `reset.ts` is a standalone CLI script: importing it runs
 * `assertNotProduction()` and kicks off `reset()` (which opens a real
 * `DataSource`) as top-level side effects. To unit test its exported table
 * list and helpers without touching a real database or the process, this
 * spec:
 *  - Mocks `typeorm`'s `DataSource` so `dataSource.initialize()` never
 *    attempts a real connection.
 *  - Sets `NODE_ENV=test` before requiring so `assertNotProduction()`
 *    passes without calling `process.exit` at import time.
 *  - Uses `jest.isolateModules` + `require` (rather than a static/dynamic
 *    `import`, which this project's ts-jest/CJS config doesn't support in
 *    specs) to get a fresh module instance per test where NODE_ENV varies.
 */

const mockQuery = jest.fn().mockResolvedValue(undefined);
const mockInitialize = jest.fn().mockResolvedValue(undefined);
const mockDestroy = jest.fn().mockResolvedValue(undefined);
const mockCreateQueryRunner = jest.fn(() => ({ query: mockQuery }));

jest.mock('typeorm', () => {
  const actual = jest.requireActual('typeorm');
  return {
    ...actual,
    DataSource: jest.fn().mockImplementation(() => ({
      initialize: mockInitialize,
      destroy: mockDestroy,
      createQueryRunner: mockCreateQueryRunner,
    })),
  };
});

/** Requires a fresh instance of `./reset` inside an isolated module registry. */
function requireResetModule(): typeof ResetModule {
  let mod!: typeof ResetModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('./reset');
  });
  return mod;
}

describe('database reset script (src/database/seeds/reset.ts)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    exitSpy.mockRestore();
    jest.clearAllMocks();
  });

  describe('SAVINGS_SEED_TABLES', () => {
    it('matches the tables seed.ts populates (users, savings accounts, goals, groups, group members, plus balances/locked_plans/anchor_deposits)', () => {
      const { SAVINGS_SEED_TABLES } = requireResetModule();

      expect(SAVINGS_SEED_TABLES).toEqual(
        expect.arrayContaining([
          'users',
          'savings_accounts',
          'goals',
          'groups',
          'group_members',
          'balances',
          'locked_plans',
          'anchor_deposits',
        ]),
      );
    });

    it('lists group_members before groups, so the FK-dependent table truncates first', () => {
      const { SAVINGS_SEED_TABLES } = requireResetModule();

      const groupMembersIndex = SAVINGS_SEED_TABLES.indexOf('group_members');
      const groupsIndex = SAVINGS_SEED_TABLES.indexOf('groups');

      expect(groupMembersIndex).toBeGreaterThanOrEqual(0);
      expect(groupsIndex).toBeGreaterThanOrEqual(0);
      expect(groupMembersIndex).toBeLessThan(groupsIndex);
    });

    it('does not include the stale prediction-market tables the old script targeted', () => {
      const { SAVINGS_SEED_TABLES } = requireResetModule();

      const staleTables = [
        'event_winners',
        'event_participants',
        'predictions',
        'matches',
        'events',
      ];

      for (const table of staleTables) {
        expect(SAVINGS_SEED_TABLES as readonly string[]).not.toContain(table);
      }
    });

    it('does not include verified_addresses (a currently-active admin table, not savings data)', () => {
      const { SAVINGS_SEED_TABLES } = requireResetModule();
      expect(SAVINGS_SEED_TABLES as readonly string[]).not.toContain(
        'verified_addresses',
      );
    });
  });

  describe('truncateTable', () => {
    it('issues a TRUNCATE ... RESTART IDENTITY CASCADE for the given table', async () => {
      const { truncateTable } = requireResetModule();
      const query = jest.fn().mockResolvedValue(undefined);
      const queryRunner = { query } as unknown as QueryRunner;

      await truncateTable(queryRunner, 'goals');

      expect(query).toHaveBeenCalledWith(
        'TRUNCATE TABLE goals RESTART IDENTITY CASCADE',
      );
    });

    it('swallows an error for a table that does not exist rather than throwing', async () => {
      const { truncateTable } = requireResetModule();
      const query = jest
        .fn()
        .mockRejectedValue(new Error('relation does not exist'));
      const queryRunner = { query } as unknown as QueryRunner;

      await expect(
        truncateTable(queryRunner, 'nonexistent_table'),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertNotProduction', () => {
    it('does not exit when NODE_ENV is not production', () => {
      process.env.NODE_ENV = 'test';
      const { assertNotProduction } = requireResetModule();

      expect(() => assertNotProduction()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('exits the process when called directly with NODE_ENV set to production', () => {
      // Require the module under a safe NODE_ENV first (so the module-level
      // call at import time doesn't itself throw), then flip to production
      // and call the exported guard directly to test it in isolation.
      process.env.NODE_ENV = 'test';
      const { assertNotProduction } = requireResetModule();

      process.env.NODE_ENV = 'production';
      expect(() => assertNotProduction()).toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('module import (top-level script execution)', () => {
    it('does not call process.exit on import when NODE_ENV is not production', () => {
      process.env.NODE_ENV = 'test';
      expect(() => requireResetModule()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('calls process.exit on import when NODE_ENV is production, before opening a DataSource', () => {
      process.env.NODE_ENV = 'production';
      expect(() => requireResetModule()).toThrow('process.exit called');
      expect(mockInitialize).not.toHaveBeenCalled();
    });
  });
});
