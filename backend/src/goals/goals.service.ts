import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Goal, GoalStatus } from './entities/goal.entity';

export interface GoalSummary {
  total_goals: number;
  active_goals: number;
  reached_goals: number;
  total_target: string;
  total_saved: string;
}

export interface PaginatedGoals {
  data: Goal[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Projects the vault contract's goal events (create/contribute/reached) into
 * the `goals` read-model consumed by the API and by notifications.
 */
@Injectable()
export class GoalsService {
  constructor(
    @InjectRepository(Goal)
    private readonly goalRepository: Repository<Goal>,
  ) {}

  async upsertCreated(params: {
    onChainId: string;
    owner: string;
    name: string;
    targetAmount: string;
  }): Promise<Goal> {
    const existing = await this.goalRepository.findOne({
      where: { on_chain_id: params.onChainId },
    });
    if (existing) return existing;

    const goal = this.goalRepository.create({
      on_chain_id: params.onChainId,
      owner: params.owner,
      name: params.name,
      target_amount: params.targetAmount,
      current_amount: '0',
      status: GoalStatus.ACTIVE,
      reached_at: null,
    });
    return this.goalRepository.save(goal);
  }

  async applyContribution(onChainId: string, amount: string): Promise<Goal> {
    const goal = await this.findByOnChainId(onChainId);
    goal.current_amount = (
      BigInt(goal.current_amount) + BigInt(amount)
    ).toString();
    return this.goalRepository.save(goal);
  }

  /** Marks a goal reached. Idempotent: a second call is a no-op (changed=false). */
  async markReached(
    onChainId: string,
  ): Promise<{ goal: Goal; changed: boolean }> {
    const goal = await this.findByOnChainId(onChainId);
    if (goal.status === GoalStatus.REACHED) {
      return { goal, changed: false };
    }
    goal.status = GoalStatus.REACHED;
    goal.reached_at = new Date();
    const saved = await this.goalRepository.save(goal);
    return { goal: saved, changed: true };
  }

  /** Fetch a single goal by its on-chain id, for a goal detail page. */
  async getByOnChainId(onChainId: string): Promise<Goal> {
    return this.findByOnChainId(onChainId);
  }

  /**
   * Records a goal as claimed once the owner's `goal_claim` transaction has
   * confirmed on-chain. This only updates the read-model status — actually
   * submitting the signed `goal_claim` invocation to the network happens
   * client-side (via the connected wallet) before this is called; see
   * `useGoalClaim` in the frontend.
   *
   * Rejects a goal that hasn't reached its target yet (BadRequest) or is
   * already claimed (BadRequest) — both mirror the on-chain contract's own
   * guards, so the UI gets a clear error even without inspecting the chain.
   */
  async claim(onChainId: string): Promise<Goal> {
    const goal = await this.findByOnChainId(onChainId);

    if (goal.status === GoalStatus.ACTIVE) {
      throw new BadRequestException(
        `Goal ${onChainId} has not reached its target yet`,
      );
    }
    if (goal.status === GoalStatus.CLAIMED) {
      throw new BadRequestException(
        `Goal ${onChainId} has already been claimed`,
      );
    }

    goal.status = GoalStatus.CLAIMED;
    return this.goalRepository.save(goal);
  }

  async list(owner?: string): Promise<Goal[]> {
    return this.goalRepository.find({
      where: owner ? { owner } : {},
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Lists an owner's goals with progress fields, paginated. `limit` is
   * capped at 100 to bound query cost, matching the convention used by
   * `NotificationsService.findAllForUser`. Always ordered by `created_at`;
   * `sort` only controls the direction (default `desc`, newest-first).
   */
  async listByOwnerPaginated(
    owner: string,
    page = 1,
    limit = 20,
    sort: 'asc' | 'desc' = 'desc',
  ): Promise<PaginatedGoals> {
    const take = Math.min(limit, 100);
    const skip = (page - 1) * take;

    const [data, total] = await this.goalRepository.findAndCount({
      where: { owner },
      order: { created_at: sort === 'asc' ? 'ASC' : 'DESC' },
      skip,
      take,
    });

    return { data, total, page, limit: take };
  }

  async summary(owner?: string): Promise<GoalSummary> {
    const goals = await this.list(owner);
    const totalTarget = goals.reduce(
      (sum, g) => sum + BigInt(g.target_amount),
      0n,
    );
    const totalSaved = goals.reduce(
      (sum, g) => sum + BigInt(g.current_amount),
      0n,
    );
    return {
      total_goals: goals.length,
      active_goals: goals.filter((g) => g.status === GoalStatus.ACTIVE).length,
      reached_goals: goals.filter((g) => g.status === GoalStatus.REACHED)
        .length,
      total_target: totalTarget.toString(),
      total_saved: totalSaved.toString(),
    };
  }

  private async findByOnChainId(onChainId: string): Promise<Goal> {
    const goal = await this.goalRepository.findOne({
      where: { on_chain_id: onChainId },
    });
    if (!goal) {
      throw new NotFoundException(`Goal ${onChainId} not found`);
    }
    return goal;
  }
}
