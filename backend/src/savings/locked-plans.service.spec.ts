import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LockedPlan } from './entities/locked-plan.entity';
import { LockedPlansService } from './locked-plans.service';

/**
 * In-memory stand-in for the TypeORM `Repository<LockedPlan>`, keyed the
 * same way the real table is (unique `on_chain_id`). Supports the
 * `findAndCount` call `listByOwner` makes, plus `create`/`save`/`findOne`
 * for `upsertCreated`.
 */
class FakeLockedPlanRepository {
  private readonly store = new Map<string, LockedPlan>();

  seed(rows: LockedPlan[]): void {
    for (const row of rows) {
      this.store.set(row.on_chain_id, row);
    }
  }

  create(partial: Partial<LockedPlan>): LockedPlan {
    return { ...partial } as LockedPlan;
  }

  async save(plan: LockedPlan): Promise<LockedPlan> {
    // Real TypeORM populates @CreateDateColumn/@UpdateDateColumn on first
    // insert; mirror that here so callers observe them set.
    const existing = this.store.get(plan.on_chain_id);
    const saved = {
      ...plan,
      id: existing?.id ?? plan.id ?? `generated-${this.store.size}`,
      created_at: existing?.created_at ?? plan.created_at ?? new Date(),
      updated_at: new Date(),
    };
    this.store.set(saved.on_chain_id, saved);
    return { ...saved };
  }

  async findOne(options: {
    where: { on_chain_id: string };
  }): Promise<LockedPlan | null> {
    const found = this.store.get(options.where.on_chain_id);
    return found ? { ...found } : null;
  }

  async findAndCount(options: {
    where: { owner: string };
    order: { unlock_at: 'ASC' | 'DESC' };
    skip: number;
    take: number;
  }): Promise<[LockedPlan[], number]> {
    const filtered = [...this.store.values()].filter(
      (r) => r.owner === options.where.owner,
    );
    const sorted = [...filtered].sort((a, b) =>
      options.order.unlock_at === 'ASC'
        ? a.unlock_at.getTime() - b.unlock_at.getTime()
        : b.unlock_at.getTime() - a.unlock_at.getTime(),
    );
    const page = sorted.slice(options.skip, options.skip + options.take);
    return [page, filtered.length];
  }
}

function makePlan(overrides: Partial<LockedPlan>): LockedPlan {
  return {
    id: 'id',
    on_chain_id: 'chain-id',
    owner: 'GOWNER',
    balance: '0',
    unlock_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('LockedPlansService', () => {
  let service: LockedPlansService;
  let repository: FakeLockedPlanRepository;

  beforeEach(async () => {
    repository = new FakeLockedPlanRepository();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LockedPlansService,
        { provide: getRepositoryToken(LockedPlan), useValue: repository },
      ],
    }).compile();

    service = module.get<LockedPlansService>(LockedPlansService);
  });

  describe('upsertCreated', () => {
    it('persists a newly created plan and reads it back with matching fields', async () => {
      const unlockAt = new Date('2030-06-01T00:00:00.000Z');

      await service.upsertCreated({
        onChainId: 'plan-1',
        owner: 'GOWNER1',
        balance: '20000000',
        unlockAt,
      });

      const result = await service.listByOwner('GOWNER1');

      expect(result.data).toHaveLength(1);
      expect(result.data[0].on_chain_id).toBe('plan-1');
      expect(result.data[0].owner).toBe('GOWNER1');
      expect(result.data[0].balance).toBe('20000000');
      expect(result.data[0].unlock_at).toEqual(unlockAt);
    });

    it('processing the same locked_created event twice does not duplicate the plan', async () => {
      const unlockAt = new Date('2030-06-01T00:00:00.000Z');
      const params = {
        onChainId: 'plan-1',
        owner: 'GOWNER1',
        balance: '20000000',
        unlockAt,
      };

      const first = await service.upsertCreated(params);
      const second = await service.upsertCreated(params);

      expect(first.on_chain_id).toBe(second.on_chain_id);

      const result = await service.listByOwner('GOWNER1');
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('leaves an existing plan unchanged if re-delivered with different data (first write wins)', async () => {
      await service.upsertCreated({
        onChainId: 'plan-1',
        owner: 'GOWNER1',
        balance: '20000000',
        unlockAt: new Date('2030-06-01T00:00:00.000Z'),
      });

      // A redelivered event should never overwrite the existing projection
      // — if it did, and the "redelivery" carried stale or corrupted data,
      // the projection would silently drift from the original on-chain
      // event instead of staying idempotent.
      await service.upsertCreated({
        onChainId: 'plan-1',
        owner: 'GOWNER2',
        balance: '999',
        unlockAt: new Date('2099-01-01T00:00:00.000Z'),
      });

      const result = await service.listByOwner('GOWNER1');
      expect(result.data).toHaveLength(1);
      expect(result.data[0].balance).toBe('20000000');
    });

    it('allows two different plans (different on_chain_id) for the same owner', async () => {
      await service.upsertCreated({
        onChainId: 'plan-1',
        owner: 'GOWNER1',
        balance: '1000',
        unlockAt: new Date('2030-01-01T00:00:00.000Z'),
      });
      await service.upsertCreated({
        onChainId: 'plan-2',
        owner: 'GOWNER1',
        balance: '2000',
        unlockAt: new Date('2030-02-01T00:00:00.000Z'),
      });

      const result = await service.listByOwner('GOWNER1');
      expect(result.total).toBe(2);
      expect(result.data.map((p) => p.on_chain_id).sort()).toEqual([
        'plan-1',
        'plan-2',
      ]);
    });
  });

  it("returns only the caller's plans, ordered by unlock_at ascending", async () => {
    repository.seed([
      makePlan({
        on_chain_id: 'p1',
        owner: 'GOWNER',
        unlock_at: new Date('2030-06-01'),
      }),
      makePlan({
        on_chain_id: 'p2',
        owner: 'GOWNER',
        unlock_at: new Date('2030-01-01'),
      }),
      makePlan({
        on_chain_id: 'p3',
        owner: 'GOTHER',
        unlock_at: new Date('2029-01-01'),
      }),
    ]);

    const result = await service.listByOwner('GOWNER');

    expect(result.data.map((p) => p.on_chain_id)).toEqual(['p2', 'p1']);
    expect(result.total).toBe(2);
  });

  it('paginates correctly across pages', async () => {
    repository.seed(
      Array.from({ length: 25 }, (_, i) =>
        makePlan({
          on_chain_id: `p${i}`,
          owner: 'GOWNER',
          unlock_at: new Date(2030, 0, i + 1),
        }),
      ),
    );

    const page1 = await service.listByOwner('GOWNER', 1, 10);
    const page2 = await service.listByOwner('GOWNER', 2, 10);
    const page3 = await service.listByOwner('GOWNER', 3, 10);

    expect(page1.data).toHaveLength(10);
    expect(page2.data).toHaveLength(10);
    expect(page3.data).toHaveLength(5);
    expect(page1.total).toBe(25);
    expect(page1.data[0].on_chain_id).toBe('p0');
    expect(page2.data[0].on_chain_id).toBe('p10');
    expect(page1.data.map((p) => p.on_chain_id)).not.toEqual(
      page2.data.map((p) => p.on_chain_id),
    );
  });

  it('caps limit at 100 even when a larger value is requested', async () => {
    repository.seed(
      Array.from({ length: 5 }, (_, i) =>
        makePlan({
          on_chain_id: `p${i}`,
          owner: 'GOWNER',
          unlock_at: new Date(2030, 0, i + 1),
        }),
      ),
    );

    const result = await service.listByOwner('GOWNER', 1, 500);

    expect(result.limit).toBe(100);
  });

  it('returns an empty page for an owner with no plans', async () => {
    const result = await service.listByOwner('GNOBODY');
    expect(result).toEqual({ data: [], total: 0, page: 1, limit: 20 });
  });
});
