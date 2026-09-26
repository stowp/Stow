import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GoalsService } from '../goals/goals.service';
import { BalanceService } from './balance.service';
import {
  SavingsProductSummaryDto,
  SavingsSummaryDto,
} from './dto/savings-summary.dto';
import { YieldPosition } from './entities/yield-position.entity';
import { YieldPositionResponseDto } from './dto/yield-position-response.dto';

@Injectable()
export class SavingsService {
  constructor(
    @InjectRepository(YieldPosition)
    private readonly yieldPositionRepository: Repository<YieldPosition>,
    private readonly balanceService: BalanceService,
    private readonly goalsService: GoalsService,
  ) {}

  ping(): { status: string } {
    return { status: 'ok' };
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

  /**
   * Get the caller's yield-adapter position.
   *
   * Returns shares, estimated asset value (based on last-known exchange rate),
   * and pending withdrawal cooldown status.
   *
   * If no position exists, returns a well-formed empty response (not an error).
   */
  async getYieldPosition(
    ownerAddress: string,
  ): Promise<YieldPositionResponseDto> {
    const position = await this.yieldPositionRepository.findOne({
      where: { owner: ownerAddress },
    });

    if (!position) {
      return {
        address: ownerAddress,
        shares: '0',
        estimated_asset_value: null,
        exchange_rate_snapshot: null,
        pending_withdrawal_claimable_at: null,
        updated_at: new Date(),
      };
    }

    // Calculate estimated asset value from shares and exchange rate
    let estimatedValue: string | null = null;
    if (position.exchange_rate_snapshot && position.shares !== '0') {
      try {
        const shares = BigInt(position.shares);
        const rate = parseFloat(position.exchange_rate_snapshot);
        if (rate > 0) {
          estimatedValue = Math.floor(Number(shares) * rate).toString();
        }
      } catch {
        // If calculation fails, leave as null
      }
    }

    return {
      address: position.owner,
      shares: position.shares,
      estimated_asset_value: estimatedValue,
      exchange_rate_snapshot: position.exchange_rate_snapshot,
      pending_withdrawal_claimable_at: null, // Will be populated by indexer when withdrawals are tracked
      updated_at: position.updated_at,
    };
  }
}
