import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GoalsService } from '../goals/goals.service';
import { BalanceService } from './balance.service';
import { GroupListItemDto, ListGroupsDto } from './dto/list-groups.dto';
import {
  SavingsProductSummaryDto,
  SavingsSummaryDto,
} from './dto/savings-summary.dto';
import { Group } from './entities/group.entity';

/**
 * Aggregates data across the individual savings-product read-models
 * (`Balance`, `Group`, `Goal`) into the cross-product views exposed by
 * `GET /savings/groups` and `GET /savings/summary`.
 */
@Injectable()
export class SavingsService {
  constructor(
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    private readonly balanceService: BalanceService,
    private readonly goalsService: GoalsService,
  ) {}

  ping(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * Groups `address` currently belongs to, each with its pooled balance
   * and open/closed status.
   *
   * Membership is checked with `address = ANY(members)`, which uses the
   * GIN index created on the `members` column (see the `groups` migration).
   */
  async listGroups(address: string): Promise<ListGroupsDto> {
    const groups = await this.groupRepository
      .createQueryBuilder('group')
      .where(':address = ANY(group.members)', { address })
      .orderBy('group.created_at', 'DESC')
      .getMany();

    return {
      address,
      groups: groups.map((group) => this.toGroupListItem(group)),
    };
  }

  /**
   * Per-product totals for `address` across the savings products the
   * backend currently tracks, plus a grand total.
   *
   * Scope note: only `flexible` (the `Balance` read-model) and `goals`
   * (the `Goal` read-model, summed by `current_amount` i.e. amount
   * actually saved so far, not `target_amount`) are included — these are
   * the two product variants defined on `SavingsProductSummaryDto`. Group
   * pool balances are intentionally excluded: a group's balance is shared
   * across all members rather than attributable to a single address, and
   * isn't one of the enumerated products.
   */
  async summary(address: string): Promise<SavingsSummaryDto> {
    const [flexible, goals] = await Promise.all([
      this.balanceService.get(address),
      this.goalsService.summary(address),
    ]);

    const products: SavingsProductSummaryDto[] = [
      { product: 'flexible', total: flexible.amount },
      { product: 'goals', total: goals.total_saved },
    ];

    const total = products
      .reduce((sum, product) => sum + BigInt(product.total), 0n)
      .toString();

    return { address, products, total };
  }

  private toGroupListItem(group: Group): GroupListItemDto {
    return {
      on_chain_id: group.on_chain_id,
      creator: group.creator,
      name: group.name,
      members: group.members,
      balance: group.balance,
      open: group.open,
    };
  }
}
