/**
 * Savings account merge – integration test (issue #625)
 *
 * Drives POST /admin/savings/accounts/merge through the real controller,
 * validation pipe and AccountMergeService against an in-memory store whose
 * transactions roll back on error, like a database transaction.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { Goal, GoalStatus } from '../../src/goals/entities/goal.entity';
import { ContractEvent } from '../../src/indexer/entities/contract-event.entity';
import { AccountMergeController } from '../../src/savings/account-merge/account-merge.controller';
import { AccountMergeService } from '../../src/savings/account-merge/account-merge.service';
import { Balance } from '../../src/savings/entities/balance.entity';
import { LockedPlan } from '../../src/savings/entities/locked-plan.entity';
import { SavingsAccount } from '../../src/savings/entities/savings-account.entity';

const SOURCE = 'G' + 'A'.repeat(55);
const TARGET = 'G' + 'B'.repeat(55);
const OTHER = 'G' + 'C'.repeat(55);

type Row = Record<string, unknown>;
type EntityClass = new () => object;
type Where = Row | Row[];

interface FakeQueryBuilder {
  update(): FakeQueryBuilder;
  set(): FakeQueryBuilder;
  where(sql: string, params: Row): FakeQueryBuilder;
  setParameters(params: Row): FakeQueryBuilder;
  execute(): Promise<{ affected: number }>;
}

const matches = (row: Row, where: Where) =>
  (Array.isArray(where) ? where : [where]).some((clause) =>
    Object.entries(clause).every(([key, value]) => row[key] === value),
  );

/**
 * Minimal in-memory stand-in for the parts of TypeORM the merge uses.
 * `transaction` snapshots every table and restores it if the work throws.
 */
class InMemoryDataSource {
  tables = new Map<EntityClass, Row[]>();
  /** Entity whose `update` should throw, to exercise rollback. */
  failOnUpdate: EntityClass | null = null;
  private nextId = 1;

  rows<T extends object>(entity: new () => T): T[] {
    return this.table(entity) as unknown as T[];
  }

  private table(entity: EntityClass): Row[] {
    if (!this.tables.has(entity)) this.tables.set(entity, []);
    return this.tables.get(entity)!;
  }

  insert<T extends object>(entity: new () => T, data: Partial<T>): T {
    const row = Object.assign(new entity(), {
      id: `id-${this.nextId++}`,
      ...data,
    });
    this.rows(entity).push(row);
    return row;
  }

  async transaction<T>(work: (manager: unknown) => Promise<T>): Promise<T> {
    const snapshot = new Map(
      [...this.tables].map(([entity, rows]) => [
        entity,
        rows.map((row) => structuredClone(row)),
      ]),
    );
    try {
      return await work(this.manager());
    } catch (error) {
      this.tables = snapshot;
      throw error;
    }
  }

  private manager() {
    return {
      find: async (entity: EntityClass, options: { where: Where }) =>
        this.table(entity).filter((row) => matches(row, options.where)),
      create: (entity: EntityClass, data: Row) =>
        Object.assign(new entity(), data),
      save: async (entities: Row | Row[]) => {
        for (const entity of Array.isArray(entities) ? entities : [entities]) {
          const table = this.table(entity.constructor as EntityClass);
          if (!table.includes(entity)) {
            entity.id ??= `id-${this.nextId++}`;
            table.push(entity);
          }
        }
        return entities;
      },
      update: async (entity: EntityClass, where: Row, patch: Row) => {
        if (this.failOnUpdate === entity) {
          throw new Error('simulated database failure');
        }
        const hits = this.table(entity).filter((row) => matches(row, where));
        hits.forEach((row) => Object.assign(row, patch));
        return { affected: hits.length };
      },
      createQueryBuilder: () => {
        let params: Row = {};
        const qb: FakeQueryBuilder = {
          update: () => qb,
          set: () => qb,
          where: (_sql: string, p: Row) => {
            params = { ...params, ...p };
            return qb;
          },
          setParameters: (p: Row) => {
            params = { ...params, ...p };
            return qb;
          },
          execute: async () => {
            const source = params.source as string;
            const target = params.target as string;
            let affected = 0;
            for (const event of this.rows(ContractEvent)) {
              const text = JSON.stringify(event.data);
              if (text.includes(source)) {
                event.data = JSON.parse(text.split(source).join(target));
                affected++;
              }
            }
            return { affected };
          },
        };
        return qb;
      },
    };
  }
}

describe('Savings account merge (integration)', () => {
  let app: INestApplication;
  let db: InMemoryDataSource;

  const merge = (body: Row) =>
    request(app.getHttpServer())
      .post('/admin/savings/accounts/merge')
      .send(body);

  const account = (owner: string) =>
    db.rows(SavingsAccount).find((a) => a.owner === owner)!;
  const flexible = (owner: string) =>
    db.rows(Balance).find((b) => b.account === owner);

  beforeEach(async () => {
    db = new InMemoryDataSource();
    db.insert(SavingsAccount, {
      owner: SOURCE,
      balance: '1500',
      archived_at: null,
      merged_into: null,
    });
    db.insert(SavingsAccount, {
      owner: TARGET,
      balance: '250',
      archived_at: null,
      merged_into: null,
    });
    db.insert(Balance, { account: SOURCE, amount: '1500' });
    db.insert(Balance, { account: TARGET, amount: '250' });
    db.insert(Goal, {
      on_chain_id: 'goal-1',
      owner: SOURCE,
      name: 'Bike',
      target_amount: '500',
      current_amount: '500',
      status: GoalStatus.ACTIVE,
      reached_at: null,
    });
    db.insert(Goal, {
      on_chain_id: 'goal-2',
      owner: SOURCE,
      name: 'Trip',
      target_amount: '5000',
      current_amount: '100',
      status: GoalStatus.ACTIVE,
      reached_at: null,
    });
    db.insert(LockedPlan, {
      on_chain_id: 'plan-1',
      owner: SOURCE,
      balance: '900',
      unlock_at: new Date('2027-01-01'),
    });
    db.insert(ContractEvent, {
      ledger: 1,
      log_index: 0,
      event_type: 'deposit',
      data: { owner: SOURCE, amount: '1500' },
    });
    db.insert(ContractEvent, {
      ledger: 2,
      log_index: 0,
      event_type: 'deposit',
      data: { owner: TARGET, amount: '250' },
    });
    db.insert(ContractEvent, {
      ledger: 3,
      log_index: 0,
      event_type: 'deposit',
      data: { owner: OTHER, amount: '75' },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [AccountMergeController],
      providers: [AccountMergeService, { provide: DataSource, useValue: db }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('moves the full balance so the sum matches after the merge', async () => {
    const res = await merge({ source_owner: SOURCE, target_owner: TARGET });

    expect(res.status).toBe(200);
    expect(res.body.balance_moved).toBe('1500');
    expect(res.body.target_balance).toBe('1750');
    expect(account(TARGET).balance).toBe('1750');
    expect(account(SOURCE).balance).toBe('0');
    expect(flexible(TARGET)?.amount).toBe('1750');
    expect(flexible(SOURCE)?.amount).toBe('0');
  });

  it('creates the target flexible balance when it had none', async () => {
    db.tables.set(
      Balance,
      db.rows(Balance).filter((b) => b.account !== TARGET),
    );

    await merge({ source_owner: SOURCE, target_owner: TARGET }).expect(200);

    expect(flexible(TARGET)?.amount).toBe('1500');
    expect(flexible(SOURCE)?.amount).toBe('0');
  });

  it('preserves transaction history under the target account', async () => {
    const res = await merge({ source_owner: SOURCE, target_owner: TARGET });

    expect(res.body.events_updated).toBe(1);
    const events = db.rows(ContractEvent);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.data.owner)).toEqual([TARGET, TARGET, OTHER]);
    expect(events[0].data.amount).toBe('1500');
    expect(JSON.stringify(events)).not.toContain(SOURCE);
  });

  it('moves goals and locked plans and recalculates goal progress', async () => {
    const res = await merge({ source_owner: SOURCE, target_owner: TARGET });

    expect(res.body.goals_moved).toBe(2);
    expect(res.body.goals_reached).toBe(1);
    expect(res.body.locked_plans_moved).toBe(1);

    const goals = db.rows(Goal);
    expect(goals.every((g) => g.owner === TARGET)).toBe(true);
    const bike = goals.find((g) => g.on_chain_id === 'goal-1')!;
    const trip = goals.find((g) => g.on_chain_id === 'goal-2')!;
    expect(bike.status).toBe(GoalStatus.REACHED);
    expect(bike.reached_at).toBeInstanceOf(Date);
    expect(trip.status).toBe(GoalStatus.ACTIVE);
    expect(trip.reached_at).toBeNull();
    expect(db.rows(LockedPlan)[0].owner).toBe(TARGET);
  });

  it('archives the source account', async () => {
    const res = await merge({ source_owner: SOURCE, target_owner: TARGET });

    expect(res.body.archived_at).toBeDefined();
    expect(account(SOURCE).archived_at).toBeInstanceOf(Date);
    expect(account(SOURCE).merged_into).toBe(TARGET);
    expect(account(TARGET).archived_at).toBeNull();

    // An archived account cannot be merged again.
    await merge({ source_owner: SOURCE, target_owner: TARGET }).expect(409);
  });

  describe('rejects incompatible accounts', () => {
    it('rejects merging an account into itself', async () => {
      await merge({ source_owner: SOURCE, target_owner: SOURCE }).expect(400);
    });

    it('rejects an unknown account', async () => {
      await merge({ source_owner: SOURCE, target_owner: OTHER }).expect(404);
    });

    it('rejects an archived target', async () => {
      account(TARGET).archived_at = new Date('2026-01-01');
      await merge({ source_owner: SOURCE, target_owner: TARGET }).expect(409);
    });

    it('rejects invalid Stellar addresses', async () => {
      await merge({
        source_owner: 'not-an-address',
        target_owner: TARGET,
      }).expect(400);
    });

    it('leaves both accounts untouched', async () => {
      account(TARGET).archived_at = new Date('2026-01-01');
      await merge({ source_owner: SOURCE, target_owner: TARGET }).expect(409);

      expect(account(SOURCE).balance).toBe('1500');
      expect(account(SOURCE).archived_at).toBeNull();
      expect(flexible(SOURCE)?.amount).toBe('1500');
    });
  });

  it('is atomic: a failure part-way leaves nothing changed', async () => {
    db.failOnUpdate = LockedPlan;

    const res = await merge({ source_owner: SOURCE, target_owner: TARGET });

    expect(res.status).toBe(500);
    expect(account(SOURCE).balance).toBe('1500');
    expect(account(SOURCE).archived_at).toBeNull();
    expect(account(SOURCE).merged_into).toBeNull();
    expect(account(TARGET).balance).toBe('250');
    expect(flexible(SOURCE)?.amount).toBe('1500');
    expect(flexible(TARGET)?.amount).toBe('250');
    expect(db.rows(Goal).every((g) => g.owner === SOURCE)).toBe(true);
    expect(db.rows(Goal).every((g) => g.status === GoalStatus.ACTIVE)).toBe(
      true,
    );
    expect(db.rows(ContractEvent)[0].data.owner).toBe(SOURCE);
  });
});
