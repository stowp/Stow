import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { User } from '../users/entities/user.entity';
import { UserReferral, ReferralStatus } from '../users/entities/user-referral.entity';
import { ReferralReward, RewardStatus, RewardType } from '../users/entities/referral-reward.entity';
import { TieredReferralReward, TierLevel, TIER_CONFIG } from './entities/tiered-referral-reward.entity';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

export interface LeaderboardEntry {
  rank: number;
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  total_referrals: number;
  qualified_referrals: number;
  tier: TierLevel;
  tier_name: string;
  total_rewards: number;
}

export interface ReferralAnalytics {
  user_id: string;
  total_referrals: number;
  qualified_referrals: number;
  pending_referrals: number;
  current_tier: TierLevel;
  tier_name: string;
  tier_bonus_awarded: boolean;
  total_rewards_earned: number;
  next_tier: TierLevel | null;
  referrals_needed_for_next_tier: number;
  leaderboard_rank: number | null;
}

@Injectable()
export class EnhancedReferralService {
  private readonly logger = new Logger(EnhancedReferralService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(UserReferral)
    private readonly referralsRepo: Repository<UserReferral>,
    @InjectRepository(ReferralReward)
    private readonly rewardsRepo: Repository<ReferralReward>,
    @InjectRepository(TieredReferralReward)
    private readonly tieredRewardsRepo: Repository<TieredReferralReward>,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Tier Management
  // ---------------------------------------------------------------------------

  async getOrCreateTierRecord(userId: string): Promise<TieredReferralReward> {
    let tierRecord = await this.tieredRewardsRepo.findOneBy({ user_id: userId });
    
    if (!tierRecord) {
      tierRecord = await this.tieredRewardsRepo.save(
        this.tieredRewardsRepo.create({
          user_id: userId,
          total_referrals: 0,
          tier: TierLevel.TIER_1,
          tier_name: TIER_CONFIG[TierLevel.TIER_1].name,
          bonus_awarded: false,
        }),
      );
    }

    return tierRecord;
  }

  async updateUserTier(userId: string): Promise<TieredReferralReward> {
    const tierRecord = await this.getOrCreateTierRecord(userId);
    
    // Get qualified referral count
    const qualifiedCount = await this.referralsRepo.count({
      where: { referrer_id: userId, status: ReferralStatus.QUALIFIED },
    });

    const totalCount = await this.referralsRepo.count({
      where: { referrer_id: userId },
    });

    tierRecord.total_referrals = totalCount;

    // Determine tier
    let newTier = TierLevel.TIER_1;
    if (qualifiedCount >= TIER_CONFIG[TierLevel.TIER_3].threshold) {
      newTier = TierLevel.TIER_3;
    } else if (qualifiedCount >= TIER_CONFIG[TierLevel.TIER_2].threshold) {
      newTier = TierLevel.TIER_2;
    }

    const tierChanged = tierRecord.tier !== newTier;
    tierRecord.tier = newTier;
    tierRecord.tier_name = TIER_CONFIG[newTier].name;

    if (tierChanged) {
      tierRecord.tier_reached_at = new Date();
      this.logger.log(`User ${userId} reached tier ${tierRecord.tier_name}`);

      // Award tier bonus if not already awarded for this tier
      if (!tierRecord.bonus_awarded && newTier > TierLevel.TIER_1) {
        await this.awardTierBonus(userId, newTier);
        tierRecord.bonus_awarded = true;
        tierRecord.bonus_awarded_at = new Date();
      }
    }

    return this.tieredRewardsRepo.save(tierRecord);
  }

  private async awardTierBonus(userId: string, tier: TierLevel): Promise<void> {
    const bonusAmount = TIER_CONFIG[tier].bonus_stroops;
    if (bonusAmount === '0') return;

    const reward = this.rewardsRepo.create({
      recipient_id: userId,
      type: RewardType.TIER_BONUS,
      amount: bonusAmount,
      asset_code: 'XLM',
      status: RewardStatus.ISSUED,
      metadata: JSON.stringify({ tier, tier_name: TIER_CONFIG[tier].name }),
    });

    await this.rewardsRepo.save(reward);
    this.logger.log(`Awarded tier bonus of ${bonusAmount} stroops to user ${userId} for tier ${tier}`);
  }

  // ---------------------------------------------------------------------------
  // Analytics
  // ---------------------------------------------------------------------------

  async getUserAnalytics(userId: string): Promise<ReferralAnalytics> {
    const [totalReferrals, qualifiedReferrals, tierRecord, leaderboardRank] = await Promise.all([
      this.referralsRepo.count({ where: { referrer_id: userId } }),
      this.referralsRepo.count({ where: { referrer_id: userId, status: ReferralStatus.QUALIFIED } }),
      this.getOrCreateTierRecord(userId),
      this.getUserRank(userId),
    ]);

    const totalRewards = await this.rewardsRepo.count({
      where: { recipient_id: userId, status: RewardStatus.ISSUED },
    });

    const pendingReferrals = totalReferrals - qualifiedReferrals;

    // Determine next tier
    let nextTier: TierLevel | null = null;
    let referralsNeeded = 0;

    if (tierRecord.tier === TierLevel.TIER_1) {
      nextTier = TierLevel.TIER_2;
      referralsNeeded = TIER_CONFIG[TierLevel.TIER_2].threshold - qualifiedReferrals;
    } else if (tierRecord.tier === TierLevel.TIER_2) {
      nextTier = TierLevel.TIER_3;
      referralsNeeded = TIER_CONFIG[TierLevel.TIER_3].threshold - qualifiedReferrals;
    }

    return {
      user_id: userId,
      total_referrals: totalReferrals,
      qualified_referrals: qualifiedReferrals,
      pending_referrals: pendingReferrals,
      current_tier: tierRecord.tier,
      tier_name: tierRecord.tier_name,
      tier_bonus_awarded: tierRecord.bonus_awarded,
      total_rewards_earned: totalRewards,
      next_tier: nextTier,
      referrals_needed_for_next_tier: Math.max(0, referralsNeeded),
      leaderboard_rank: leaderboardRank,
    };
  }

  // ---------------------------------------------------------------------------
  // Leaderboard
  // ---------------------------------------------------------------------------

  async getLeaderboard(query: PaginationQueryDto): Promise<{
    data: LeaderboardEntry[];
    meta: any;
  }> {
    const { page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    // Get users with their referral counts
    const stats = await this.referralsRepo
      .createQueryBuilder('ref')
      .select('ref.referrer_id', 'user_id')
      .addSelect('COUNT(*)', 'total')
      .addSelect('COUNT(CASE WHEN ref.status = :qualified THEN 1 END)', 'qualified')
      .where('ref.status = :status', { status: ReferralStatus.QUALIFIED })
      .orWhere('ref.status = :pending', { pending: ReferralStatus.PENDING })
      .setParameter('qualified', ReferralStatus.QUALIFIED)
      .setParameter('pending', ReferralStatus.PENDING)
      .groupBy('ref.referrer_id')
      .orderBy('qualified', 'DESC')
      .addOrderBy('ref.created_at', 'ASC')
      .offset(skip)
      .limit(limit)
      .getRawMany();

    // Get user details and tier info
    const userIds = stats.map((s) => s.user_id);
    const users = await this.usersRepo.findByIds(userIds);
    const userMap = new Map(users.map((u) => [u.id, u]));

    const tierRecords = await this.tieredRewardsRepo.findByIds(userIds);
    const tierMap = new Map(tierRecords.map((t) => [t.user_id, t]));

    const totalQualified = await this.referralsRepo.count({
      where: { status: ReferralStatus.QUALIFIED },
    });

    const data: LeaderboardEntry[] = stats.map((stat, index) => {
      const user = userMap.get(stat.user_id);
      const tierRecord = tierMap.get(stat.user_id) || {
        tier: TierLevel.TIER_1,
        tier_name: 'Bronze',
      };

      return {
        rank: skip + index + 1,
        user_id: stat.user_id,
        username: user?.username || null,
        avatar_url: user?.avatar_url || null,
        total_referrals: parseInt(stat.total),
        qualified_referrals: parseInt(stat.qualified),
        tier: tierRecord.tier,
        tier_name: tierRecord.tier_name,
        total_rewards: parseInt(stat.qualified) * 2, // Referrer + referee rewards
      };
    });

    return {
      data,
      meta: {
        total: totalQualified,
        page,
        limit,
        totalPages: Math.ceil(totalQualified / limit),
      },
    };
  }

  async getUserRank(userId: string): Promise<number | null> {
    const result = await this.referralsRepo
      .createQueryBuilder('ref')
      .select('ref.referrer_id', 'user_id')
      .addSelect('COUNT(CASE WHEN ref.status = :qualified THEN 1 END)', 'qualified_count')
      .where('ref.status = :qualified', { qualified: ReferralStatus.QUALIFIED })
      .orWhere('ref.status = :pending', { pending: ReferralStatus.PENDING })
      .groupBy('ref.referrer_id')
      .orderBy('qualified_count', 'DESC')
      .getRawMany();

    const rank = result.findIndex((r) => r.user_id === userId);
    return rank === -1 ? null : rank + 1;
  }

  // ---------------------------------------------------------------------------
  // Admin Analytics Dashboard
  // ---------------------------------------------------------------------------

  async getAdminReferralDashboard(): Promise<{
    overview: {
      total_referrals: number;
      total_qualified: number;
      total_pending: number;
      conversion_rate: number;
      total_rewards_issued: number;
    };
    tiers: {
      tier: string;
      count: number;
      percentage: number;
    }[];
    top_referrers: LeaderboardEntry[];
    recent_activity: {
      date: string;
      new_referrals: number;
      qualified_referrals: number;
    }[];
  }> {
    const [total, qualified, pending, rewardsIssued] = await Promise.all([
      this.referralsRepo.count(),
      this.referralsRepo.count({ where: { status: ReferralStatus.QUALIFIED } }),
      this.referralsRepo.count({ where: { status: ReferralStatus.PENDING } }),
      this.rewardsRepo.count({ where: { status: RewardStatus.ISSUED } }),
    ]);

    const conversionRate = total > 0 ? Math.round((qualified / total) * 100 * 10) / 10 : 0;

    // Tier distribution
    const tierRecords = await this.tieredRewardsRepo.find();
    const tierDistribution = {
      [TierLevel.TIER_1]: 0,
      [TierLevel.TIER_2]: 0,
      [TierLevel.TIER_3]: 0,
    };

    for (const record of tierRecords) {
      tierDistribution[record.tier]++;
    }

    const totalUsers = tierRecords.length || 1;
    const tiers = [
      { tier: 'Bronze', count: tierDistribution[TierLevel.TIER_1], percentage: Math.round((tierDistribution[TierLevel.TIER_1] / totalUsers) * 100 * 10) / 10 },
      { tier: 'Silver', count: tierDistribution[TierLevel.TIER_2], percentage: Math.round((tierDistribution[TierLevel.TIER_2] / totalUsers) * 100 * 10) / 10 },
      { tier: 'Gold', count: tierDistribution[TierLevel.TIER_3], percentage: Math.round((tierDistribution[TierLevel.TIER_3] / totalUsers) * 100 * 10) / 10 },
    ];

    // Top referrers
    const topReferrers = await this.getLeaderboard({ page: 1, limit: 10 });

    // Recent activity (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentReferrals = await this.referralsRepo
      .createQueryBuilder('ref')
      .where('ref.created_at >= :date', { date: sevenDaysAgo })
      .getMany();

    const activityByDate = new Map<string, { new: number; qualified: number }>();
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const key = date.toISOString().split('T')[0];
      activityByDate.set(key, { new: 0, qualified: 0 });
    }

    for (const ref of recentReferrals) {
      const key = ref.created_at.toISOString().split('T')[0];
      const activity = activityByDate.get(key);
      if (activity) {
        if (ref.status === ReferralStatus.PENDING) activity.new++;
        else if (ref.status === ReferralStatus.QUALIFIED) activity.qualified++;
      }
    }

    const recentActivity = Array.from(activityByDate.entries())
      .map(([date, activity]) => ({
        date,
        new_referrals: activity.new,
        qualified_referrals: activity.qualified,
      }))
      .reverse();

    return {
      overview: {
        total_referrals: total,
        total_qualified: qualified,
        total_pending: pending,
        conversion_rate: conversionRate,
        total_rewards_issued: rewardsIssued,
      },
      tiers,
      top_referrers: topReferrers.data,
      recent_activity: recentActivity,
    };
  }
}