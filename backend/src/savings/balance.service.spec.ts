import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Balance } from './entities/balance.entity';
import { BalanceService } from './balance.service';

describe('BalanceService – caching', () => {
  let service: BalanceService;
  let repo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  const ACCOUNT = 'GSTELLAR_ACCOUNT';
  const CACHE_KEY = `savings:balance:${ACCOUNT}`;

  beforeEach(async () => {
    repo = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() };
    cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(Balance), useValue: repo },
        { provide: CACHE_MANAGER, useValue: cache },
      ],
    }).compile();

    service = module.get(BalanceService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('get', () => {
    it('returns cached value without hitting the DB on repeated reads', async () => {
      const cached = { account: ACCOUNT, amount: '500' };
      cache.get.mockResolvedValue(cached);

      const result = await service.get(ACCOUNT);

      expect(cache.get).toHaveBeenCalledWith(CACHE_KEY);
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(result).toEqual(cached);
    });

    it('queries DB on cache miss and populates cache', async () => {
      cache.get.mockResolvedValue(null);
      repo.findOne.mockResolvedValue({ account: ACCOUNT, amount: '200' });
      cache.set.mockResolvedValue(undefined);

      const result = await service.get(ACCOUNT);

      expect(repo.findOne).toHaveBeenCalledTimes(1);
      expect(cache.set).toHaveBeenCalledWith(
        CACHE_KEY,
        { account: ACCOUNT, amount: '200' },
        10_000,
      );
      expect(result.amount).toBe('200');
    });

    it('returns zero balance when account not found and caches it', async () => {
      cache.get.mockResolvedValue(null);
      repo.findOne.mockResolvedValue(null);
      cache.set.mockResolvedValue(undefined);

      const result = await service.get(ACCOUNT);

      expect(result.amount).toBe('0');
      expect(cache.set).toHaveBeenCalledWith(CACHE_KEY, { account: ACCOUNT, amount: '0' }, 10_000);
    });
  });

  describe('credit', () => {
    it('invalidates the cache after crediting', async () => {
      const existing = { account: ACCOUNT, amount: '100' };
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockResolvedValue({ ...existing, amount: '150' });
      cache.del.mockResolvedValue(undefined);

      await service.credit(ACCOUNT, '50');

      expect(cache.del).toHaveBeenCalledWith(CACHE_KEY);
    });

    it('creates a new balance record when none exists and invalidates cache', async () => {
      repo.findOne.mockResolvedValue(null);
      repo.create.mockReturnValue({ account: ACCOUNT, amount: '0' });
      repo.save.mockResolvedValue({ account: ACCOUNT, amount: '75' });
      cache.del.mockResolvedValue(undefined);

      await service.credit(ACCOUNT, '75');

      expect(repo.create).toHaveBeenCalledWith({ account: ACCOUNT, amount: '0' });
      expect(cache.del).toHaveBeenCalledWith(CACHE_KEY);
    });
  });

  describe('findAccount', () => {
    it('returns the balance and timestamps for a known account', async () => {
      const created_at = new Date('2026-01-01');
      const updated_at = new Date('2026-02-01');
      repo.findOne.mockResolvedValue({
        account: ACCOUNT,
        amount: '5000000',
        created_at,
        updated_at,
      });

      const result = await service.findAccount(ACCOUNT);

      expect(repo.findOne).toHaveBeenCalledWith({ where: { account: ACCOUNT } });
      expect(result).toEqual({
        account: ACCOUNT,
        amount: '5000000',
        created_at,
        updated_at,
      });
    });

    it('returns null for an account that has never been observed', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.findAccount('GUNKNOWN');

      expect(result).toBeNull();
    });

    it('does not use the cache (unlike get())', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.findAccount(ACCOUNT);

      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });
  });
});
