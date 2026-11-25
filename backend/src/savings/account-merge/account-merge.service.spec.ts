import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Goal } from '../../goals/entities/goal.entity';
import { ContractEvent } from '../../indexer/entities/contract-event.entity';
import { LockedPlan } from '../entities/locked-plan.entity';
import { SavingsAccount } from '../entities/savings-account.entity';
import { AccountMergeService } from './account-merge.service';

const SOURCE = 'G' + 'A'.repeat(55);
const TARGET = 'G' + 'B'.repeat(55);

function account(owner: string, balance: string, archived = false) {
  return Object.assign(new SavingsAccount(), {
    owner,
    balance,
    archived_at: archived ? new Date('2026-01-01') : null,
    merged_into: null,
  });
}

describe('AccountMergeService', () => {
  let service: AccountMergeService;
  let manager: {
    find: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let qb: Record<string, jest.Mock>;
  let dataSource: { transaction: jest.Mock };

  beforeEach(() => {
    qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 2 }),
    };
    manager = {
      find: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest
        .fn()
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValueOnce({ affected: 3 }),
      createQueryBuilder: jest.fn(() => qb),
    };
    dataSource = {
      transaction: jest.fn((work: (m: typeof manager) => unknown) =>
        work(manager),
      ),
    };
    service = new AccountMergeService(dataSource as unknown as DataSource);
  });

  it('moves balance, goals, plans and history to the target and archives the source', async () => {
    const source = account(SOURCE, '1500');
    const target = account(TARGET, '250');
    manager.find.mockResolvedValueOnce([source, target]).mockResolvedValue([]);

    const result = await service.merge(SOURCE, TARGET);

    expect(result.balance_moved).toBe('1500');
    expect(result.target_balance).toBe('1750');
    expect(result.goals_moved).toBe(1);
    expect(result.locked_plans_moved).toBe(3);
    expect(result.events_updated).toBe(2);
    expect(target.balance).toBe('1750');
    expect(source.balance).toBe('0');
    expect(source.merged_into).toBe(TARGET);
    expect(source.archived_at).toBeInstanceOf(Date);
    expect(manager.save).toHaveBeenCalledWith([target, source]);
    expect(manager.update).toHaveBeenCalledWith(
      Goal,
      { owner: SOURCE },
      { owner: TARGET },
    );
    expect(manager.update).toHaveBeenCalledWith(
      LockedPlan,
      { owner: SOURCE },
      { owner: TARGET },
    );
    expect(manager.createQueryBuilder).toHaveBeenCalledWith();
    expect(qb.update).toHaveBeenCalledWith(ContractEvent);
  });

  it('rejects merging an account into itself', async () => {
    await expect(service.merge(SOURCE, SOURCE)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects when either account does not exist', async () => {
    manager.find.mockResolvedValue([account(SOURCE, '10')]);
    await expect(service.merge(SOURCE, TARGET)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('rejects when either account is already archived', async () => {
    manager.find.mockResolvedValue([
      account(SOURCE, '10', true),
      account(TARGET, '0'),
    ]);
    await expect(service.merge(SOURCE, TARGET)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(manager.save).not.toHaveBeenCalled();
  });
});
