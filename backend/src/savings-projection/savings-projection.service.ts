import { Injectable, Logger } from '@nestjs/common';
import { GoalsService } from '../goals/goals.service';
import { BalanceService } from '../savings/balance.service';
import { GroupsService } from '../savings/groups.service';
import { LockedPlansService } from '../savings/locked-plans.service';
import { NotificationGeneratorService } from '../notifications/notification-generator.service';

/**
 * Applies a single savings-vault contract event to the off-chain
 * projections (goals, balances, groups, locked plans). Shared by the
 * indexer's event-store pipeline and the Soroban listener's live poll loop
 * so both dispatch on `topic[0]` the same way.
 *
 * Every handler here is idempotent on its own terms (upsert-by-on-chain-id,
 * or a status/settled flag guarding the state change); callers are
 * responsible for not re-delivering the same event once it has been
 * durably checkpointed.
 */
@Injectable()
export class SavingsProjectionService {
  private readonly logger = new Logger(SavingsProjectionService.name);

  constructor(
    private readonly goalsService: GoalsService,
    private readonly balanceService: BalanceService,
    private readonly groupsService: GroupsService,
    private readonly lockedPlansService: LockedPlansService,
    private readonly notificationGeneratorService: NotificationGeneratorService,
  ) {}

  async apply(topic: string, data: Record<string, unknown>): Promise<void> {
    switch (topic) {
      case 'goal_created': {
        await this.goalsService.upsertCreated({
          onChainId: String(data.id ?? data.goal_id),
          owner: String(data.owner),
          name: typeof data.name === 'string' ? data.name : '',
          targetAmount: String(data.target_amount),
        });
        break;
      }

      case 'goal_contribution': {
        const goal = await this.goalsService.applyContribution(
          String(data.id ?? data.goal_id),
          String(data.amount),
        );
        if (BigInt(goal.current_amount) >= BigInt(goal.target_amount)) {
          await this.markGoalReachedAndNotify(goal.on_chain_id);
        }
        break;
      }

      case 'goal_reached': {
        await this.markGoalReachedAndNotify(String(data.id ?? data.goal_id));
        break;
      }

      case 'locked_created': {
        await this.lockedPlansService.upsertCreated({
          onChainId: String(data.id ?? data.plan_id),
          owner: String(data.owner),
          balance: String(data.amount),
          unlockAt: this.toDate(data.unlock_at),
        });
        break;
      }

      case 'deposit': {
        const account = data.owner ?? data.user ?? data.account;
        await this.balanceService.credit(String(account), String(data.amount));
        break;
      }

      case 'withdraw': {
        // Set to the contract's own post-withdrawal balance rather than
        // decrementing by the withdrawn amount — see BalanceService.setBalance
        // for why this is what makes replaying the same event idempotent.
        const account = data.owner ?? data.user ?? data.account;
        await this.balanceService.setBalance(
          String(account),
          String(data.new_balance),
        );
        break;
      }

      case 'group_split_settled': {
        const { changed } = await this.groupsService.markSettled(
          String(data.id ?? data.group_id),
        );
        if (changed) {
          await this.notificationGeneratorService.handleGroupSettled(data);
        }
        break;
      }

      default:
        this.logger.debug(`No projection handler for topic "${topic}"`);
        break;
    }
  }

  private async markGoalReachedAndNotify(onChainId: string): Promise<void> {
    const { goal, changed } = await this.goalsService.markReached(onChainId);
    if (!changed) return;
    await this.notificationGeneratorService.handleGoalReached({
      goalId: goal.on_chain_id,
      owner: goal.owner,
      name: goal.name,
      targetAmount: goal.target_amount,
    });
  }

  /**
   * Converts a contract event's `unlock_at` field — a Soroban `u64` ledger
   * timestamp in whole seconds since the Unix epoch, decoded as a JS
   * `number`, `string`, or `bigint` depending on the XDR normalization step
   * upstream — into a `Date` for the `locked_plans` projection.
   */
  private toDate(value: unknown): Date {
    const seconds =
      typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
    return new Date(seconds * 1000);
  }
}
