import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cache } from 'cache-manager';
import { Inject } from '@nestjs/common';
import {
  AccountTypeEntity,
  AccountType,
} from './entities/account-type.entity';
import {
  AccountComparisonQueryDto,
  ProjectEarningsDto,
  AccountComparisonResponseDto,
} from './dto/account-comparison.dto';

@Injectable()
export class AccountComparisonService {
  private readonly logger = new Logger(AccountComparisonService.name);
  private readonly CACHE_TTL = 3600000; // 1 hour

  constructor(
    @InjectRepository(AccountTypeEntity)
    private readonly accountTypeRepo: Repository<AccountTypeEntity>,
    @Inject('CACHE_MANAGER')
    private readonly cacheManager: Cache,
  ) {}

  async getAccountTypes(
    query: AccountComparisonQueryDto,
  ): Promise<{ data: AccountComparisonResponseDto[]; meta: any }> {
    const cacheKey = `account_types:${JSON.stringify(query)}`;
    const cached = await this.cacheManager.get<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const { page = 1, limit = 20, min_apy, max_lock_period, allows_withdrawal, features } = query;
    const skip = (page - 1) * limit;

    const qb = this.accountTypeRepo
      .createQueryBuilder('at')
      .where('at.is_active = :isActive', { isActive: true });

    if (min_apy !== undefined) {
      qb.andWhere('at.apy >= :minApy', { minApy: min_apy });
    }

    if (max_lock_period !== undefined) {
      qb.andWhere('(at.lock_period_days IS NULL OR at.lock_period_days <= :maxLock)', {
        maxLock: max_lock_period,
      });
    }

    if (allows_withdrawal !== undefined) {
      qb.andWhere('at.allows_withdrawal = :allowsWithdrawal', {
        allowsWithdrawal: allows_withdrawal,
      });
    }

    if (features && features.length > 0) {
      qb.andWhere('at.features @> :features', { features: JSON.stringify(features) });
    }

    qb.orderBy('at.sort_order', 'ASC').skip(skip).take(limit);

    const [data, total] = await qb.getManyAndCount();

    const response: AccountComparisonResponseDto[] = data.map((at) => ({
      id: at.id,
      type: at.type,
      name: at.name,
      description: at.description,
      icon: at.icon,
      apy: Number(at.apy),
      lock_period_days: at.lock_period_days,
      allows_withdrawal: at.allows_withdrawal,
      early_withdrawal_penalty: at.early_withdrawal_penalty,
      early_withdrawal_penalty_percent: Number(at.early_withdrawal_penalty_percent),
      minimum_deposit: at.minimum_deposit,
      maximum_deposit: at.maximum_deposit,
      features: at.features,
      pros: at.pros,
      cons: at.cons,
    }));

    const result = {
      data: response,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };

    await this.cacheManager.set(cacheKey, result, this.CACHE_TTL);
    return result;
  }

  async getAccountTypeById(id: string): Promise<AccountComparisonResponseDto> {
    const cacheKey = `account_type:${id}`;
    const cached = await this.cacheManager.get<AccountComparisonResponseDto>(cacheKey);
    if (cached) {
      return cached;
    }

    const at = await this.accountTypeRepo.findOneBy({ id, is_active: true });
    if (!at) {
      throw new NotFoundException(`Account type ${id} not found`);
    }

    const response: AccountComparisonResponseDto = {
      id: at.id,
      type: at.type,
      name: at.name,
      description: at.description,
      icon: at.icon,
      apy: Number(at.apy),
      lock_period_days: at.lock_period_days,
      allows_withdrawal: at.allows_withdrawal,
      early_withdrawal_penalty: at.early_withdrawal_penalty,
      early_withdrawal_penalty_percent: Number(at.early_withdrawal_penalty_percent),
      minimum_deposit: at.minimum_deposit,
      maximum_deposit: at.maximum_deposit,
      features: at.features,
      pros: at.pros,
      cons: at.cons,
    };

    await this.cacheManager.set(cacheKey, response, this.CACHE_TTL);
    return response;
  }

  async projectEarnings(dto: ProjectEarningsDto): Promise<{
    account_type: string;
    deposit_amount: number;
    days: number;
    projections: {
      daily: number;
      weekly: number;
      monthly: number;
      yearly: number;
      total: number;
    };
  }> {
    const accountType = await this.accountTypeRepo.findOneBy({
      type: dto.account_type as AccountType,
      is_active: true,
    });

    if (!accountType) {
      throw new NotFoundException(`Account type ${dto.account_type} not found`);
    }

    const apy = Number(accountType.apy) / 100;
    const dailyRate = apy / 365;
    const daily = dto.deposit_amount * dailyRate;
    const weekly = daily * 7;
    const monthly = daily * 30;
    const yearly = daily * 365;
    const total = (daily * dto.days);

    return {
      account_type: dto.account_type,
      deposit_amount: dto.deposit_amount,
      days: dto.days,
      projections: {
        daily: Math.round(daily * 100) / 100,
        weekly: Math.round(weekly * 100) / 100,
        monthly: Math.round(monthly * 100) / 100,
        yearly: Math.round(yearly * 100) / 100,
        total: Math.round(total * 100) / 100,
      },
    };
  }

  async seedDefaultAccountTypes(): Promise<void> {
    const count = await this.accountTypeRepo.count();
    if (count > 0) {
      this.logger.log('Account types already seeded');
      return;
    }

    const defaultTypes: Partial<AccountTypeEntity>[] = [
      {
        type: AccountType.FLEXIBLE,
        name: 'Flexible Savings',
        description: 'Access your funds anytime with no lock period. Great for emergency funds.',
        icon: 'flexible',
        apy: 2.5,
        lock_period_days: null,
        allows_withdrawal: true,
        early_withdrawal_penalty: false,
        early_withdrawal_penalty_percent: 0,
        minimum_deposit: '0',
        maximum_deposit: null,
        features: ['Instant withdrawal', 'No minimum balance', 'Compound interest'],
        pros: ['Full liquidity', 'No penalties', 'Easy access'],
        cons: ['Lower APY', 'No bonus rates'],
        sort_order: 1,
      },
      {
        type: AccountType.LOCKED_30,
        name: '30-Day Locked',
        description: 'Lock your savings for 30 days for higher yields.',
        icon: 'lock_30',
        apy: 4.0,
        lock_period_days: 30,
        allows_withdrawal: false,
        early_withdrawal_penalty: true,
        early_withdrawal_penalty_percent: 2,
        minimum_deposit: '100',
        maximum_deposit: null,
        features: ['Higher APY', '30-day commitment', 'Penalty for early exit'],
        pros: ['Better returns than flexible', 'Short lock period'],
        cons: ['No withdrawals', 'Early exit penalty'],
        sort_order: 2,
      },
      {
        type: AccountType.LOCKED_60,
        name: '60-Day Locked',
        description: 'Lock your savings for 60 days for improved yields.',
        icon: 'lock_60',
        apy: 4.5,
        lock_period_days: 60,
        allows_withdrawal: false,
        early_withdrawal_penalty: true,
        early_withdrawal_penalty_percent: 3,
        minimum_deposit: '100',
        maximum_deposit: null,
        features: ['Higher APY', '60-day commitment', 'Penalty for early exit'],
        pros: ['Better returns', 'Medium-term commitment'],
        cons: ['No withdrawals', 'Early exit penalty'],
        sort_order: 3,
      },
      {
        type: AccountType.LOCKED_90,
        name: '90-Day Locked',
        description: 'Lock your savings for 90 days for even better yields.',
        icon: 'lock_90',
        apy: 5.0,
        lock_period_days: 90,
        allows_withdrawal: false,
        early_withdrawal_penalty: true,
        early_withdrawal_penalty_percent: 4,
        minimum_deposit: '100',
        maximum_deposit: null,
        features: ['Premium APY', '90-day commitment', 'Penalty for early exit'],
        pros: ['Great returns', 'Quarterly commitment'],
        cons: ['No withdrawals', 'Early exit penalty'],
        sort_order: 4,
      },
      {
        type: AccountType.LOCKED_180,
        name: '180-Day Locked',
        description: 'Lock your savings for 180 days for excellent yields.',
        icon: 'lock_180',
        apy: 6.0,
        lock_period_days: 180,
        allows_withdrawal: false,
        early_withdrawal_penalty: true,
        early_withdrawal_penalty_percent: 5,
        minimum_deposit: '500',
        maximum_deposit: null,
        features: ['Excellent APY', '6-month commitment', 'Penalty for early exit'],
        pros: ['Top returns', 'Long-term benefit'],
        cons: ['No withdrawals', 'Higher early exit penalty'],
        sort_order: 5,
      },
      {
        type: AccountType.LOCKED_365,
        name: '1-Year Locked',
        description: 'Lock your savings for 365 days for maximum yields.',
        icon: 'lock_365',
        apy: 7.5,
        lock_period_days: 365,
        allows_withdrawal: false,
        early_withdrawal_penalty: true,
        early_withdrawal_penalty_percent: 6,
        minimum_deposit: '1000',
        maximum_deposit: null,
        features: ['Maximum APY', '1-year commitment', 'Penalty for early exit'],
        pros: ['Best returns', 'Maximum benefit'],
        cons: ['No withdrawals for 1 year', 'Highest early exit penalty'],
        sort_order: 6,
      },
      {
        type: AccountType.YIELD,
        name: 'Yield Account',
        description: 'Earn yield on your deposits with flexible access.',
        icon: 'yield',
        apy: 3.5,
        lock_period_days: null,
        allows_withdrawal: true,
        early_withdrawal_penalty: false,
        early_withdrawal_penalty_percent: 0,
        minimum_deposit: '50',
        maximum_deposit: '100000',
        features: ['Competitive APY', 'Flexible access', 'Daily compounding'],
        pros: ['Good returns with flexibility', 'Daily interest', 'Easy withdrawals'],
        cons: ['Subject to rate changes', 'Deposit limits'],
        sort_order: 7,
      },
    ];

    await this.accountTypeRepo.save(defaultTypes);
    this.logger.log('Default account types seeded');
  }
}