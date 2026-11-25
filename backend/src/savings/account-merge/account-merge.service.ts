import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Goal, GoalStatus } from '../../goals/entities/goal.entity';
import { ContractEvent } from '../../indexer/entities/contract-event.entity';
import { Balance } from '../entities/balance.entity';
import { LockedPlan } from '../entities/locked-plan.entity';
import { SavingsAccount } from '../entities/savings-account.entity';

export interface MergeSavingsAccountsResult {
  source_owner: string;
  target_owner: string;
  balance_moved: string;
  target_balance: string;
  goals_moved: number;
  /** Moved goals whose progress now meets their target and were marked reached. */
  goals_reached: number;
  locked_plans_moved: number;
  events_updated: number;
  archived_at: Date;
}

@Injectable()
export class AccountMergeService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Merges `sourceOwner` into `targetOwner` in one transaction: the balance
   * (both the savings account and the flexible `balances` read model), goals
   * and locked plans move to the target, goal progress is recalculated,
   * indexed events that name the source are rewritten to the target, and the
   * source row is archived. Any failure rolls the whole merge back.
   * Only the projection changes; on-chain balances are not touched.
   */
  async merge(
    sourceOwner: string,
    targetOwner: string,
  ): Promise<MergeSavingsAccountsResult> {
    if (sourceOwner === targetOwner) {
      throw new BadRequestException(
        'Source and target accounts must be different',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const accounts = await manager.find(SavingsAccount, {
        where: [{ owner: sourceOwner }, { owner: targetOwner }],
        lock: { mode: 'pessimistic_write' },
      });
      const [source, target] = requireMergeable(
        accounts,
        sourceOwner,
        targetOwner,
      );

      const balanceMoved = BigInt(source.balance);
      target.balance = (BigInt(target.balance) + balanceMoved).toString();
      const archivedAt = new Date();
      source.balance = '0';
      source.archived_at = archivedAt;
      source.merged_into = targetOwner;
      await manager.save([target, source]);
      await this.moveFlexibleBalance(manager, sourceOwner, targetOwner);

      const goals = await manager.update(
        Goal,
        { owner: sourceOwner },
        { owner: targetOwner },
      );
      const goalsReached = await this.recalculateGoalProgress(
        manager,
        targetOwner,
      );
      const plans = await manager.update(
        LockedPlan,
        { owner: sourceOwner },
        { owner: targetOwner },
      );
      const events = await manager
        .createQueryBuilder()
        .update(ContractEvent)
        .set({
          data: () => 'REPLACE("data"::text, :source, :target)::jsonb',
        })
        .where('"data"::text LIKE :pattern', { pattern: `%${sourceOwner}%` })
        .setParameters({ source: sourceOwner, target: targetOwner })
        .execute();

      return {
        source_owner: sourceOwner,
        target_owner: targetOwner,
        balance_moved: balanceMoved.toString(),
        target_balance: target.balance,
        goals_moved: goals.affected ?? 0,
        goals_reached: goalsReached,
        locked_plans_moved: plans.affected ?? 0,
        events_updated: events.affected ?? 0,
        archived_at: archivedAt,
      };
    });
  }

  /**
   * Adds the source's flexible `balances` row to the target's (creating it if
   * needed) and zeroes the source, so balance reads reflect the merge.
   */
  private async moveFlexibleBalance(
    manager: EntityManager,
    sourceOwner: string,
    targetOwner: string,
  ): Promise<void> {
    const rows = await manager.find(Balance, {
      where: [{ account: sourceOwner }, { account: targetOwner }],
      lock: { mode: 'pessimistic_write' },
    });
    const source = rows.find((b) => b.account === sourceOwner);
    if (!source || BigInt(source.amount) === 0n) {
      return;
    }
    const target =
      rows.find((b) => b.account === targetOwner) ??
      manager.create(Balance, { account: targetOwner, amount: '0' });
    target.amount = (BigInt(target.amount) + BigInt(source.amount)).toString();
    source.amount = '0';
    await manager.save([target, source]);
  }

  /**
   * Goals keep their own contributions, so moving them does not change their
   * amounts. Re-checks every active goal the target now owns against its
   * target amount and marks the ones that are met as reached.
   */
  private async recalculateGoalProgress(
    manager: EntityManager,
    targetOwner: string,
  ): Promise<number> {
    const active = await manager.find(Goal, {
      where: { owner: targetOwner, status: GoalStatus.ACTIVE },
    });
    const reached = active.filter(
      (goal) => BigInt(goal.current_amount) >= BigInt(goal.target_amount),
    );
    if (reached.length === 0) {
      return 0;
    }
    const reachedAt = new Date();
    for (const goal of reached) {
      goal.status = GoalStatus.REACHED;
      goal.reached_at = reachedAt;
    }
    await manager.save(reached);
    return reached.length;
  }
}

/**
 * Returns the source and target accounts if they can be merged: both must
 * exist and be live flexible savings accounts. Every `savings_accounts` row
 * is the same account type, so the remaining check is that neither side has
 * already been merged away.
 */
function requireMergeable(
  accounts: SavingsAccount[],
  sourceOwner: string,
  targetOwner: string,
): [SavingsAccount, SavingsAccount] {
  const source = accounts.find((a) => a.owner === sourceOwner);
  const target = accounts.find((a) => a.owner === targetOwner);
  if (!source || !target) {
    throw new NotFoundException('Savings account not found');
  }
  if (source.archived_at || target.archived_at) {
    throw new ConflictException('Archived savings accounts cannot be merged');
  }
  return [source, target];
}
