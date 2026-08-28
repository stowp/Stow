import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Goal, GoalStatus } from './entities/goal.entity';
import { GoalsService } from './goals.service';

/**
 * In-memory stand-in for the TypeORM `Repository<Goal>`, keyed the same way
 * the real table is (unique `on_chain_id`). Used to exercise persist/read
 * round trips through GoalsService without a live database connection.
 */
class FakeGoalRepository {
  private readonly store = new Map<string, Goal>();

  create(partial: Partial<Goal>): Goal {
    return { ...partial } as Goal;
  }

  async save(goal: Goal): Promise<Goal> {
    // Real TypeORM populates @CreateDateColumn on first insert; mirror that
    // here so callers (e.g. pagination ordering by created_at) see it set.
    const existing = this.store.get(goal.on_chain_id);
    const saved = {
      ...goal,
      created_at: existing?.created_at ?? goal.created_at ?? new Date(),
    };
    this.store.set(saved.on_chain_id, saved);
    return { ...saved };
  }

  async findOne(options: {
    where: { on_chain_id: string };
  }): Promise<Goal | null> {
    const found = this.store.get(options.where.on_chain_id);
    return found ? { ...found } : null;
  }

  async find(options?: { where?: { owner?: string } }): Promise<Goal[]> {
    const all = [...this.store.values()];
    const filtered = options?.where?.owner
      ? all.filter((g) => g.owner === options.where!.owner)
      : all;
    return filtered.map((g) => ({ ...g }));
  }

  async findAndCount(options: {
    where: { owner: string };
    order: { created_at: 'ASC' | 'DESC' };
    skip: number;
    take: number;
  }): Promise<[Goal[], number]> {
    const filtered = [...this.store.values()].filter(
      (g) => g.owner === options.where.owner,
    );
    const sorted = [...filtered].sort((a, b) =>
      options.order.created_at === 'ASC'
        ? a.created_at.getTime() - b.created_at.getTime()
        : b.created_at.getTime() - a.created_at.getTime(),
    );
    const page = sorted
      .slice(options.skip, options.skip + options.take)
      .map((g) => ({ ...g }));
    return [page, filtered.length];
  }
}

describe('GoalsService – persistence', () => {
  let service: GoalsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoalsService,
        {
          provide: getRepositoryToken(Goal),
          useValue: new FakeGoalRepository(),
        },
      ],
    }).compile();

    service = module.get(GoalsService);
  });

  it('persists a newly created goal and reads it back with matching fields', async () => {
    await service.upsertCreated({
      onChainId: 'goal-1',
      owner: 'GOWNER1',
      name: 'Holiday fund',
      targetAmount: '1000000',
    });

    const [readBack] = await service.list('GOWNER1');

    expect(readBack.on_chain_id).toBe('goal-1');
    expect(readBack.owner).toBe('GOWNER1');
    expect(readBack.name).toBe('Holiday fund');
    expect(readBack.target_amount).toBe('1000000');
    expect(readBack.current_amount).toBe('0');
    expect(readBack.status).toBe(GoalStatus.ACTIVE);
    expect(readBack.reached_at).toBeNull();
  });

  it('persists a contribution and reads back the updated saved amount', async () => {
    await service.upsertCreated({
      onChainId: 'goal-2',
      owner: 'GOWNER2',
      name: 'Car',
      targetAmount: '500',
    });

    await service.applyContribution('goal-2', '200');

    const [readBack] = await service.list('GOWNER2');
    expect(readBack.current_amount).toBe('200');
  });

  it('persists the reached milestone and reads back reached_at set', async () => {
    await service.upsertCreated({
      onChainId: 'goal-3',
      owner: 'GOWNER3',
      name: 'Bike',
      targetAmount: '100',
    });
    await service.applyContribution('goal-3', '100');
    await service.markReached('goal-3');

    const [readBack] = await service.list('GOWNER3');
    expect(readBack.status).toBe(GoalStatus.REACHED);
    expect(readBack.reached_at).toBeInstanceOf(Date);
  });

  it('reads goals back filtered by owner', async () => {
    await service.upsertCreated({
      onChainId: 'owner-a-goal',
      owner: 'OWNER_A',
      name: 'A',
      targetAmount: '10',
    });
    await service.upsertCreated({
      onChainId: 'owner-b-goal',
      owner: 'OWNER_B',
      name: 'B',
      targetAmount: '20',
    });

    const ownerAGoals = await service.list('OWNER_A');
    expect(ownerAGoals).toHaveLength(1);
    expect(ownerAGoals[0].on_chain_id).toBe('owner-a-goal');
  });
});

describe('GoalsService – listByOwnerPaginated', () => {
  let service: GoalsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoalsService,
        {
          provide: getRepositoryToken(Goal),
          useValue: new FakeGoalRepository(),
        },
      ],
    }).compile();

    service = module.get(GoalsService);

    for (let i = 0; i < 25; i++) {
      await service.upsertCreated({
        onChainId: `goal-${i}`,
        owner: 'GOWNER',
        name: `Goal ${i}`,
        targetAmount: '100',
      });
    }
    await service.upsertCreated({
      onChainId: 'other-owner-goal',
      owner: 'GOTHER',
      name: 'Not mine',
      targetAmount: '50',
    });
  });

  it("returns only the caller's goals with correct saved/target values", async () => {
    await service.applyContribution('goal-0', '40');

    const result = await service.listByOwnerPaginated('GOWNER', 1, 100);

    expect(result.total).toBe(25);
    expect(result.data.every((g) => g.owner === 'GOWNER')).toBe(true);
    const goal0 = result.data.find((g) => g.on_chain_id === 'goal-0');
    expect(goal0?.target_amount).toBe('100');
    expect(goal0?.current_amount).toBe('40');
  });

  it('paginates correctly across pages', async () => {
    const page1 = await service.listByOwnerPaginated('GOWNER', 1, 10);
    const page2 = await service.listByOwnerPaginated('GOWNER', 2, 10);
    const page3 = await service.listByOwnerPaginated('GOWNER', 3, 10);

    expect(page1.data).toHaveLength(10);
    expect(page2.data).toHaveLength(10);
    expect(page3.data).toHaveLength(5);
    expect(page1.total).toBe(25);

    const allIds = [...page1.data, ...page2.data, ...page3.data].map(
      (g) => g.on_chain_id,
    );
    expect(new Set(allIds).size).toBe(25);
  });

  it('caps limit at 100 even when a larger value is requested', async () => {
    const result = await service.listByOwnerPaginated('GOWNER', 1, 500);
    expect(result.limit).toBe(100);
  });

  it('returns an empty page for an owner with no goals', async () => {
    const result = await service.listByOwnerPaginated('GNOBODY');
    expect(result).toEqual({ data: [], total: 0, page: 1, limit: 20 });
  });

  describe('sort direction', () => {
    // The shared beforeEach's 25-goal seed loop runs fast enough that
    // real-clock created_at values can collide within the same
    // millisecond, making ASC/DESC order unreliable to assert against.
    // These tests seed their own small set with explicit, controlled
    // timestamps via fake timers instead.
    let sortService: GoalsService;

    beforeEach(async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GoalsService,
          {
            provide: getRepositoryToken(Goal),
            useValue: new FakeGoalRepository(),
          },
        ],
      }).compile();
      sortService = module.get(GoalsService);

      await sortService.upsertCreated({
        onChainId: 'goal-earliest',
        owner: 'GSORT',
        name: 'Earliest',
        targetAmount: '100',
      });
      jest.advanceTimersByTime(1000);
      await sortService.upsertCreated({
        onChainId: 'goal-middle',
        owner: 'GSORT',
        name: 'Middle',
        targetAmount: '100',
      });
      jest.advanceTimersByTime(1000);
      await sortService.upsertCreated({
        onChainId: 'goal-latest',
        owner: 'GSORT',
        name: 'Latest',
        targetAmount: '100',
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('defaults to newest-first (created_at DESC) when sort is omitted', async () => {
      const result = await sortService.listByOwnerPaginated('GSORT', 1, 10);
      expect(result.data.map((g) => g.on_chain_id)).toEqual([
        'goal-latest',
        'goal-middle',
        'goal-earliest',
      ]);
    });

    it('reverses to oldest-first when sort="asc"', async () => {
      const result = await sortService.listByOwnerPaginated(
        'GSORT',
        1,
        10,
        'asc',
      );
      expect(result.data.map((g) => g.on_chain_id)).toEqual([
        'goal-earliest',
        'goal-middle',
        'goal-latest',
      ]);
    });

    it('explicit sort="desc" matches the default', async () => {
      const result = await sortService.listByOwnerPaginated(
        'GSORT',
        1,
        10,
        'desc',
      );
      expect(result.data[0].on_chain_id).toBe('goal-latest');
    });
  });
});
