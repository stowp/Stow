import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IndexerService, CHECKPOINT_LEDGER_KEY } from './indexer.service';
import {
  ContractEvent,
  ContractEventStatus,
} from './entities/contract-event.entity';
import { FeeHistory } from './entities/fee-history.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import {
  PendingWithdrawal,
  PendingWithdrawalStatus,
} from './entities/pending-withdrawal.entity';
import { HarvestHistory } from './entities/harvest-history.entity';
import { ReconciliationService } from './reconciliation.service';
import { SorobanService, SorobanRpcEvent } from '../soroban/soroban.service';
import { SavingsProjectionService } from '../savings-projection/savings-projection.service';

describe('IndexerService', () => {
  let service: IndexerService;

  let contractEventRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  let checkpointRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
  };

  let pendingWithdrawalRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };

  let harvestHistoryRepo: {
    create: jest.Mock;
    save: jest.Mock;
  };

  let sorobanService: {
    getEvents: jest.Mock;
  };

  let configService: {
    get: jest.Mock;
  };

  beforeEach(async () => {
    contractEventRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((dto) => ({
        id: 'uuid-1',
        ...dto,
      })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      createQueryBuilder: jest.fn(),
    };

    checkpointRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    };

    pendingWithdrawalRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((dto) => ({ ...dto })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    harvestHistoryRepo = {
      create: jest.fn().mockImplementation((dto) => ({ ...dto })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    };

    sorobanService = {
      getEvents: jest.fn().mockResolvedValue({ events: [], latestLedger: 100 }),
    };

    configService = {
      get: jest.fn((key: string) => {
        if (key === 'SOROBAN_CONTRACT_ID') return 'C1234567890VAULT';
        return null;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexerService,
        { provide: ConfigService, useValue: configService },
        {
          provide: getRepositoryToken(ContractEvent),
          useValue: contractEventRepo,
        },
        { provide: getRepositoryToken(FeeHistory), useValue: {} },
        {
          provide: getRepositoryToken(IndexerCheckpoint),
          useValue: checkpointRepo,
        },
        {
          provide: getRepositoryToken(PendingWithdrawal),
          useValue: pendingWithdrawalRepo,
        },
        {
          provide: getRepositoryToken(HarvestHistory),
          useValue: harvestHistoryRepo,
        },
        { provide: ReconciliationService, useValue: {} },
        { provide: SorobanService, useValue: sorobanService },
        {
          provide: SavingsProjectionService,
          useValue: { apply: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<IndexerService>(IndexerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('pollContractEvents', () => {
    it('skips polling when contractId is not configured', async () => {
      configService.get.mockReturnValue('your-contract-id-here');

      await service.pollContractEvents();

      expect(sorobanService.getEvents).not.toHaveBeenCalled();
    });

    it('fetches events from Soroban RPC, persists as PENDING, processes them, and advances checkpoint', async () => {
      checkpointRepo.findOne.mockResolvedValue(null); // start checkpoint = 0

      const mockEvents: SorobanRpcEvent[] = [
        {
          id: 'evt-1',
          ledger: 10,
          topic: ['deposit'],
          value: { user: 'G123', amount: '100' },
          txHash: 'hash1',
        },
        {
          id: 'evt-2',
          ledger: 12,
          topic: ['withdraw'],
          value: { user: 'G456', amount: '50' },
          txHash: 'hash2',
        },
      ];

      sorobanService.getEvents.mockResolvedValue({
        events: mockEvents,
        latestLedger: 15,
      });

      // Mock processPendingBatch find
      contractEventRepo.find.mockResolvedValue([
        {
          id: 'uuid-1',
          ledger: 10,
          log_index: 0,
          event_type: 'deposit',
          data: { user: 'G123', amount: '100' },
          tx_hash: 'hash1',
          status: ContractEventStatus.PENDING,
          retry_count: 0,
        },
        {
          id: 'uuid-2',
          ledger: 12,
          log_index: 1,
          event_type: 'withdraw',
          data: { user: 'G456', amount: '50' },
          tx_hash: 'hash2',
          status: ContractEventStatus.PENDING,
          retry_count: 0,
        },
      ]);

      await service.pollContractEvents();

      // Verify Soroban RPC was called starting from startLedger = 1 (0 + 1)
      expect(sorobanService.getEvents).toHaveBeenCalledWith(1);

      // Verify events were saved as PENDING
      expect(contractEventRepo.create).toHaveBeenCalledTimes(2);
      expect(contractEventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ledger: 10,
          log_index: 0,
          event_type: 'deposit',
          status: ContractEventStatus.PENDING,
        }),
      );

      // Verify processPendingBatch set status to PROCESSED
      expect(contractEventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ContractEventStatus.PROCESSED,
        }),
      );

      // Verify checkpoint was updated to latest ledger (15)
      expect(checkpointRepo.save).toHaveBeenCalledWith({
        key: CHECKPOINT_LEDGER_KEY,
        value: 15,
      });
    });

    it('advances checkpoint safely when range is empty', async () => {
      // Current checkpoint is at ledger 50
      checkpointRepo.findOne.mockImplementation(
        ({ where }: { where: { key: string } }) => {
          if (where.key === CHECKPOINT_LEDGER_KEY) {
            return Promise.resolve({ key: CHECKPOINT_LEDGER_KEY, value: 50 });
          }
          return Promise.resolve(null);
        },
      );

      // Soroban RPC returns no events, but latest ledger is 60
      sorobanService.getEvents.mockResolvedValue({
        events: [],
        latestLedger: 60,
      });

      await service.pollContractEvents();

      expect(sorobanService.getEvents).toHaveBeenCalledWith(51);
      expect(contractEventRepo.create).not.toHaveBeenCalled();

      // Checkpoint advances to 60
      expect(checkpointRepo.save).toHaveBeenCalledWith({
        key: CHECKPOINT_LEDGER_KEY,
        value: 60,
      });
    });

    it('skips duplicate events that already exist in database', async () => {
      checkpointRepo.findOne.mockResolvedValue(null);

      const mockEvents: SorobanRpcEvent[] = [
        {
          id: 'evt-1',
          ledger: 10,
          topic: ['deposit'],
          value: { user: 'G123' },
        },
      ];

      sorobanService.getEvents.mockResolvedValue({
        events: mockEvents,
        latestLedger: 10,
      });

      // Simulate event already existing in DB
      contractEventRepo.findOne.mockResolvedValue({ id: 'existing-id' });

      await service.pollContractEvents();

      expect(contractEventRepo.create).not.toHaveBeenCalled();
      expect(checkpointRepo.save).toHaveBeenCalledWith({
        key: CHECKPOINT_LEDGER_KEY,
        value: 10,
      });
    });
  });

  describe('decodeAndApply — yield-adapter events', () => {
    /** Drives a single pending `ContractEvent` through `applyEvent`/`decodeAndApply`. */
    function runPending(event: Record<string, unknown>) {
      contractEventRepo.find.mockResolvedValue([
        {
          id: 'uuid-1',
          ledger: 42,
          log_index: 0,
          tx_hash: 'hash-1',
          retry_count: 0,
          status: ContractEventStatus.PENDING,
          ...event,
        },
      ]);
      return service.pollContractEvents();
    }

    it('withdraw_requested: creates a pending withdrawal keyed by request id', async () => {
      await runPending({
        event_type: 'withdraw_requested',
        data: {
          id: '5',
          owner: 'GOWNER',
          shares: '1000',
          claimable_at: 1700000000,
        },
      });

      expect(pendingWithdrawalRepo.findOne).toHaveBeenCalledWith({
        where: { request_id: '5' },
      });
      expect(pendingWithdrawalRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          request_id: '5',
          owner: 'GOWNER',
          shares: '1000',
          status: PendingWithdrawalStatus.PENDING,
          claimable_at: new Date(1700000000 * 1000),
        }),
      );
      expect(pendingWithdrawalRepo.save).toHaveBeenCalled();
      expect(contractEventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ContractEventStatus.PROCESSED }),
      );
    });

    it('withdraw_requested: does not duplicate an already-indexed request id', async () => {
      pendingWithdrawalRepo.findOne.mockResolvedValue({
        id: 'existing',
        request_id: '5',
      });

      await runPending({
        event_type: 'withdraw_requested',
        data: {
          id: '5',
          owner: 'GOWNER',
          shares: '1000',
          claimable_at: 1700000000,
        },
      });

      expect(pendingWithdrawalRepo.create).not.toHaveBeenCalled();
      expect(pendingWithdrawalRepo.save).not.toHaveBeenCalled();
    });

    it('withdraw_cancelled: marks the matching pending withdrawal cancelled, not claimed', async () => {
      await runPending({
        event_type: 'withdraw_cancelled',
        data: { id: '5' },
      });

      expect(pendingWithdrawalRepo.update).toHaveBeenCalledWith(
        { request_id: '5' },
        expect.objectContaining({
          status: PendingWithdrawalStatus.CANCELLED,
          cancelled_at: expect.any(Date),
        }),
      );
      expect(pendingWithdrawalRepo.update).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: PendingWithdrawalStatus.CLAIMED }),
      );
    });

    it('harvested: decodes a positive-yield report with its fee', async () => {
      await runPending({
        event_type: 'harvested',
        data: { delta: '500', fee: '50', timestamp: 1700000000 },
      });

      expect(harvestHistoryRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          delta: '500',
          fee: '50',
          harvested_at: new Date(1700000000 * 1000),
          ledger: 42,
          tx_hash: 'hash-1',
        }),
      );
      expect(harvestHistoryRepo.save).toHaveBeenCalled();
    });

    it('harvested: decodes a negative-loss report with no fee', async () => {
      await runPending({
        event_type: 'harvested',
        data: { delta: '-200', timestamp: 1700000000 },
      });

      expect(harvestHistoryRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ delta: '-200', fee: '0' }),
      );
    });
  });

  describe('backfillEvents', () => {
    it('fetches and backfills missing events in the given range', async () => {
      const mockEvents: SorobanRpcEvent[] = [
        {
          id: 'evt-1',
          ledger: 20,
          topic: ['goal_reached'],
          value: { goalId: '1' },
          txHash: 'hash-backfill',
        },
      ];

      sorobanService.getEvents.mockImplementation((from: number) => {
        if (from === 15) {
          return Promise.resolve({ events: mockEvents, latestLedger: 30 });
        }
        return Promise.resolve({ events: [], latestLedger: 30 });
      });

      contractEventRepo.findOne.mockResolvedValue(null);

      const result = await service.backfillEvents(15, 25);

      expect(sorobanService.getEvents).toHaveBeenCalledWith(15);
      expect(result).toEqual({
        total_fetched: 1,
        newly_processed: 1,
        already_indexed: 0,
        errors: 0,
        from_ledger: 15,
        to_ledger: 25,
      });
    });

    it('pages through the full range when a single RPC call does not cover it', async () => {
      contractEventRepo.findOne.mockResolvedValue(null);

      sorobanService.getEvents.mockImplementation((from: number) => {
        if (from === 15) {
          return Promise.resolve({
            events: [
              { id: 'evt-1', ledger: 16, topic: ['deposit'], value: {} },
              { id: 'evt-2', ledger: 18, topic: ['deposit'], value: {} },
            ],
            latestLedger: 100,
          });
        }
        if (from === 19) {
          return Promise.resolve({
            events: [
              { id: 'evt-3', ledger: 20, topic: ['deposit'], value: {} },
              { id: 'evt-4', ledger: 25, topic: ['deposit'], value: {} },
            ],
            latestLedger: 100,
          });
        }
        return Promise.resolve({ events: [], latestLedger: 100 });
      });

      const result = await service.backfillEvents(15, 25);

      expect(sorobanService.getEvents).toHaveBeenCalledWith(15);
      expect(sorobanService.getEvents).toHaveBeenCalledWith(19);
      // The next page would start past toLedger (26 > 25), so it must not
      // fetch a third page.
      expect(sorobanService.getEvents).not.toHaveBeenCalledWith(26);
      expect(result).toEqual({
        total_fetched: 4,
        newly_processed: 4,
        already_indexed: 0,
        errors: 0,
        from_ledger: 15,
        to_ledger: 25,
      });
    });

    it('stops paging once the RPC returns no further events', async () => {
      contractEventRepo.findOne.mockResolvedValue(null);

      sorobanService.getEvents.mockImplementation((from: number) => {
        if (from === 15) {
          return Promise.resolve({
            events: [
              { id: 'evt-1', ledger: 16, topic: ['deposit'], value: {} },
            ],
            latestLedger: 100,
          });
        }
        return Promise.resolve({ events: [], latestLedger: 100 });
      });

      const result = await service.backfillEvents(15, 500);

      expect(sorobanService.getEvents).toHaveBeenCalledWith(15);
      expect(sorobanService.getEvents).toHaveBeenCalledWith(17);
      expect(sorobanService.getEvents).toHaveBeenCalledTimes(2);
      expect(result.total_fetched).toBe(1);
      expect(result.newly_processed).toBe(1);
    });

    it('counts already-indexed events without reprocessing them', async () => {
      sorobanService.getEvents.mockImplementation((from: number) => {
        if (from === 15) {
          return Promise.resolve({
            events: [
              { id: 'evt-1', ledger: 20, topic: ['deposit'], value: {} },
            ],
            latestLedger: 100,
          });
        }
        return Promise.resolve({ events: [], latestLedger: 100 });
      });
      contractEventRepo.findOne.mockResolvedValue({ id: 'existing-id' });

      const result = await service.backfillEvents(15, 25);

      expect(contractEventRepo.create).not.toHaveBeenCalled();
      expect(result).toEqual({
        total_fetched: 1,
        newly_processed: 0,
        already_indexed: 1,
        errors: 0,
        from_ledger: 15,
        to_ledger: 25,
      });
    });
  });
});
