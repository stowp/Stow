import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LockedPlan } from './entities/locked-plan.entity';

export interface PaginatedLockedPlans {
  data: LockedPlan[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Read/write access to the `locked_plans` projection, populated from the
 * vault contract's `locked_created`/`locked_top_up`/`locked_withdraw`
 * events (see `SavingsProjectionService`, which drives `upsertCreated`).
 */
@Injectable()
export class LockedPlansService {
  constructor(
    @InjectRepository(LockedPlan)
    private readonly lockedPlanRepository: Repository<LockedPlan>,
  ) {}

  /**
   * Projects a `locked_created` event into the `locked_plans` table.
   *
   * Idempotent by `on_chain_id`: if a plan with this on-chain id already
   * exists (e.g. the indexer redelivers the same event, or a checkpoint
   * replay reprocesses it), the existing row is returned unchanged rather
   * than inserting a duplicate.
   */
  async upsertCreated(params: {
    onChainId: string;
    owner: string;
    balance: string;
    unlockAt: Date;
  }): Promise<LockedPlan> {
    const existing = await this.lockedPlanRepository.findOne({
      where: { on_chain_id: params.onChainId },
    });
    if (existing) return existing;

    const plan = this.lockedPlanRepository.create({
      on_chain_id: params.onChainId,
      owner: params.owner,
      balance: params.balance,
      unlock_at: params.unlockAt,
    });
    return this.lockedPlanRepository.save(plan);
  }

  /**
   * Lists an owner's locked plans, soonest-unlocking first, paginated.
   * `limit` is capped at 100 to bound query cost, matching the convention
   * used by `NotificationsService.findAllForUser`.
   */
  async listByOwner(
    owner: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedLockedPlans> {
    const take = Math.min(limit, 100);
    const skip = (page - 1) * take;

    const [data, total] = await this.lockedPlanRepository.findAndCount({
      where: { owner },
      order: { unlock_at: 'ASC' },
      skip,
      take,
    });

    return { data, total, page, limit: take };
  }
}
