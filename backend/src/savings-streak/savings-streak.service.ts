import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SavingsStreak, StreakPeriod, BadgeType, BADGE_CONFIG } from './entities/savings-streak.entity';
import { SavingsBadge } from './entities/savings-streak.entity';
import { User } from '../users/entities/user.entity';
import { NotificationsService } from '../notifications/notifications.service';

export interface StreakStats {
  user_id: string;
  daily_streak: {
    current: number;
    longest: number;
    last_deposit_at: Date | null;
    streak_broken: boolean;
  };
  weekly_streak: {
    current: number;
    longest: number;
    last_deposit_at: Date | null;
    streak_broken: boolean;
  };
  badges: {
    id: string;
    badge_type: BadgeType;
    badge_name: string;
    description: string;
    icon: string | null;
    earned_at: Date;
  }[];
}

export interface StreakLeaderboardEntry {
  rank: number;
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  current_streak: number;
  longest_streak: number;
  badges_count: number;
}

@Injectable()
export class SavingsStreakService {
  private readonly logger = new Logger(SavingsStreakService.name);
  private readonly REMINDER_HOURS_BEFORE_BREAK = 24;

  constructor(
    @InjectRepository(SavingsStreak)
    private readonly streakRepo: Repository<SavingsStreak>,
    @InjectRepository(SavingsBadge)
    private readonly badgeRepo: Repository<SavingsBadge>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly notificationsService: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Core Streak Operations
  // ---------------------------------------------------------------------------

  async recordDeposit(userId: string): Promise<{ streak: SavingsStreak; newBadges: SavingsBadge[] }> {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Get or create daily streak
    let dailyStreak = await this.streakRepo.findOne({
      where: { user_id: userId, period: StreakPeriod.DAILY },
    });

    if (!dailyStreak) {
      dailyStreak = this.streakRepo.create({
        user_id: userId,
        period: StreakPeriod.DAILY,
        current_streak: 1,
        longest_streak: 1,
        last_deposit_at: now,
        streak_start_date: now,
      });
    } else {
      // Check if deposit is on a new day
      const lastDepositDate = dailyStreak.last_deposit_at
        ? new Date(
            dailyStreak.last_deposit_at.getFullYear(),
            dailyStreak.last_deposit_at.getMonth(),
            dailyStreak.last_deposit_at.getDate(),
          )
        : null;

      if (lastDepositDate) {
        const daysDiff = Math.floor(
          (today.getTime() - lastDepositDate.getTime()) / (1000 * 60 * 60 * 24),
        );

        if (daysDiff === 0) {
          // Same day, just update timestamp
          dailyStreak.last_deposit_at = now;
        } else if (daysDiff === 1) {
          // Consecutive day, increment streak
          dailyStreak.current_streak++;
          dailyStreak.last_deposit_at = now;
          dailyStreak.streak_broken = false;
          if (dailyStreak.current_streak > dailyStreak.longest_streak) {
            dailyStreak.longest_streak = dailyStreak.current_streak;
          }
        } else {
          // Streak broken, reset
          dailyStreak.current_streak = 1;
          dailyStreak.last_deposit_at = now;
          dailyStreak.streak_start_date = now;
          dailyStreak.streak_broken = true;
          dailyStreak.streak_broken_at = now;
        }
      }
    }

    // Get or create weekly streak
    let weeklyStreak = await this.streakRepo.findOne({
      where: { user_id: userId, period: StreakPeriod.WEEKLY },
    });

    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());

    if (!weeklyStreak) {
      weeklyStreak = this.streakRepo.create({
        user_id: userId,
        period: StreakPeriod.WEEKLY,
        current_streak: 1,
        longest_streak: 1,
        last_deposit_at: now,
        streak_start_date: now,
      });
    } else {
      const lastWeekStart = weeklyStreak.last_deposit_at
        ? new Date(weeklyStreak.last_deposit_at)
        : null;
      lastWeekStart?.setDate(lastWeekStart.getDate() - lastWeekStart.getDay());

      if (lastWeekStart && lastWeekStart.getTime() === startOfWeek.getTime()) {
        // Same week, update timestamp
        weeklyStreak.last_deposit_at = now;
      } else {
        // New week
        weeklyStreak.current_streak++;
        weeklyStreak.last_deposit_at = now;
        if (weeklyStreak.current_streak > weeklyStreak.longest_streak) {
          weeklyStreak.longest_streak = weeklyStreak.current_streak;
        }
      }
    }

    // Save streaks
    await this.streakRepo.save([dailyStreak, weeklyStreak]);

    // Check and award badges
    const newBadges = await this.checkAndAwardBadges(userId, dailyStreak, weeklyStreak);

    this.logger.log(`Recorded deposit for user ${userId}, daily streak: ${dailyStreak.current_streak}`);
    return { streak: dailyStreak, newBadges };
  }

  async getStreakStats(userId: string): Promise<StreakStats> {
    const [dailyStreak, weeklyStreak, badges] = await Promise.all([
      this.streakRepo.findOne({
        where: { user_id: userId, period: StreakPeriod.DAILY },
      }),
      this.streakRepo.findOne({
        where: { user_id: userId, period: StreakPeriod.WEEKLY },
      }),
      this.badgeRepo.find({
        where: { user_id: userId },
        order: { earned_at: 'DESC' },
      }),
    ]);

    return {
      user_id: userId,
      daily_streak: {
        current: dailyStreak?.current_streak || 0,
        longest: dailyStreak?.longest_streak || 0,
        last_deposit_at: dailyStreak?.last_deposit_at || null,
        streak_broken: dailyStreak?.streak_broken || false,
      },
      weekly_streak: {
        current: weeklyStreak?.current_streak || 0,
        longest: weeklyStreak?.longest_streak || 0,
        last_deposit_at: weeklyStreak?.last_deposit_at || null,
        streak_broken: weeklyStreak?.streak_broken || false,
      },
      badges: badges.map((b) => ({
        id: b.id,
        badge_type: b.badge_type,
        badge_name: b.badge_name,
        description: b.description,
        icon: b.icon,
        earned_at: b.earned_at,
      })),
    };
  }

  private async checkAndAwardBadges(
    userId: string,
    dailyStreak: SavingsStreak,
    weeklyStreak: SavingsStreak,
  ): Promise<SavingsBadge[]> {
    const earnedBadges = await this.badgeRepo.find({ where: { user_id: userId } });
    const earnedTypes = new Set(earnedBadges.map((b) => b.badge_type));
    const newBadges: SavingsBadge[] = [];

    // Check streak badges
    const streakBadges: BadgeType[] = [
      BadgeType.STREAK_7_DAYS,
      BadgeType.STREAK_14_DAYS,
      BadgeType.STREAK_30_DAYS,
      BadgeType.STREAK_60_DAYS,
      BadgeType.STREAK_100_DAYS,
      BadgeType.STREAK_180_DAYS,
      BadgeType.STREAK_365_DAYS,
    ];

    const streakMilestones = {
      [BadgeType.STREAK_7_DAYS]: 7,
      [BadgeType.STREAK_14_DAYS]: 14,
      [BadgeType.STREAK_30_DAYS]: 30,
      [BadgeType.STREAK_60_DAYS]: 60,
      [BadgeType.STREAK_100_DAYS]: 100,
      [BadgeType.STREAK_180_DAYS]: 180,
      [BadgeType.STREAK_365_DAYS]: 365,
    };

    for (const badgeType of streakBadges) {
      if (!earnedTypes.has(badgeType) && dailyStreak.current_streak >= streakMilestones[badgeType]) {
        const config = BADGE_CONFIG[badgeType];
        const badge = this.badgeRepo.create({
          user_id: userId,
          badge_type: badgeType,
          badge_name: config.name,
          description: config.description,
          icon: config.icon,
          streak_milestone: config.streak_milestone,
          earned_at: new Date(),
        });
        newBadges.push(badge);

        // Notify user
        await this.notificationsService.createNotification({
          user_id: userId,
          type: 'badge_earned',
          title: '🎉 Badge Earned!',
          message: `You earned the "${config.name}" badge!`,
          metadata: { badge_type: badgeType },
        });
      }
    }

    if (newBadges.length > 0) {
      await this.badgeRepo.save(newBadges);
    }

    return newBadges;
  }

  // ---------------------------------------------------------------------------
  // Streak Leaderboard
  // ---------------------------------------------------------------------------

  async getStreakLeaderboard(limit = 20): Promise<StreakLeaderboardEntry[]> {
    const streaks = await this.streakRepo
      .createQueryBuilder('s')
      .where('s.period = :period', { period: StreakPeriod.DAILY })
      .andWhere('s.current_streak > 0')
      .orderBy('s.current_streak', 'DESC')
      .addOrderBy('s.longest_streak', 'DESC')
      .limit(limit)
      .getMany();

    const userIds = streaks.map((s) => s.user_id);
    const users = await this.userRepo.findByIds(userIds);
    const userMap = new Map(users.map((u) => [u.id, u]));

    const badges = await this.badgeRepo
      .createQueryBuilder('b')
      .where('b.user_id IN (:...userIds)', { userIds })
      .getMany();

    const badgeCountMap = new Map<string, number>();
    for (const badge of badges) {
      badgeCountMap.set(badge.user_id, (badgeCountMap.get(badge.user_id) || 0) + 1);
    }

    return streaks.map((s, index) => {
      const user = userMap.get(s.user_id);
      return {
        rank: index + 1,
        user_id: s.user_id,
        username: user?.username || null,
        avatar_url: user?.avatar_url || null,
        current_streak: s.current_streak,
        longest_streak: s.longest_streak,
        badges_count: badgeCountMap.get(s.user_id) || 0,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Reminders (called by cron job)
  // ---------------------------------------------------------------------------

  @Cron(CronExpression.EVERY_HOUR)
  async sendStreakReminders(): Promise<void> {
    this.logger.log('Checking for streak reminders...');

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(23, 59, 59, 999);

    // Find users who deposited yesterday but not today
    const atRiskStreaks = await this.streakRepo
      .createQueryBuilder('s')
      .where('s.period = :period', { period: StreakPeriod.DAILY })
      .andWhere('s.current_streak > 0')
      .andWhere('s.last_deposit_at >= :yesterday', { yesterday })
      .andWhere('s.reminder_sent_at IS NULL')
      .getMany();

    for (const streak of atRiskStreaks) {
      const lastDeposit = streak.last_deposit_at ? new Date(streak.last_deposit_at) : null;
      if (!lastDeposit) continue;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const lastDepositDay = new Date(lastDeposit);
      lastDepositDay.setHours(0, 0, 0, 0);

      // If last deposit was yesterday and no deposit today, send reminder
      if (lastDepositDay.getTime() === yesterday.getTime()) {
        await this.notificationsService.createNotification({
          user_id: streak.user_id,
          type: 'streak_reminder',
          title: '🔥 Keep Your Streak Going!',
          message: `You have a ${streak.current_streak}-day streak! Don't break it — make a deposit today to keep it going.`,
          metadata: { current_streak: streak.current_streak },
        });

        streak.reminder_sent_at = new Date();
        await this.streakRepo.save(streak);
      }
    }

    // Check for broken streaks
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    twoDaysAgo.setHours(23, 59, 59, 999);

    const brokenStreaks = await this.streakRepo
      .createQueryBuilder('s')
      .where('s.period = :period', { period: StreakPeriod.DAILY })
      .andWhere('s.current_streak > 0')
      .andWhere('s.last_deposit_at < :twoDaysAgo', { twoDaysAgo })
      .andWhere('s.streak_broken = :false', { false: false })
      .getMany();

    for (const streak of brokenStreaks) {
      if (streak.last_deposit_at) {
        const lastDeposit = new Date(streak.last_deposit_at);
        const today = new Date();
        const daysDiff = Math.floor(
          (today.getTime() - lastDeposit.getTime()) / (1000 * 60 * 60 * 24),
        );

        if (daysDiff >= 2) {
          streak.streak_broken = true;
          streak.streak_broken_at = new Date();
          await this.streakRepo.save(streak);

          await this.notificationsService.createNotification({
            user_id: streak.user_id,
            type: 'streak_broken',
            title: '💔 Streak Broken',
            message: `Your ${streak.current_streak}-day streak has ended. Start a new one today!`,
            metadata: { 
              longest_streak: streak.longest_streak,
              days_broken: daysDiff,
            },
          });
        }
      }
    }

    this.logger.log(`Processed ${atRiskStreaks.length} reminders and ${brokenStreaks.length} broken streaks`);
  }

  // ---------------------------------------------------------------------------
  // Admin Stats
  // ---------------------------------------------------------------------------

  async getStreakStatsOverview(): Promise<{
    total_users_with_streaks: number;
    average_streak: number;
    longest_current_streak: number;
    total_badges_issued: number;
    top_streaks: StreakLeaderboardEntry[];
    streak_distribution: { streak_range: string; count: number }[];
  }> {
    const [totalStreaks, avgResult, longestStreak, totalBadges] = await Promise.all([
      this.streakRepo.count({ where: { period: StreakPeriod.DAILY, current_streak: 0 } }),
      this.streakRepo
        .createQueryBuilder('s')
        .where('s.period = :period', { period: StreakPeriod.DAILY })
        .andWhere('s.current_streak > 0')
        .select('AVG(s.current_streak)', 'avg')
        .getRawOne(),
      this.streakRepo
        .createQueryBuilder('s')
        .where('s.period = :period', { period: StreakPeriod.DAILY })
        .orderBy('s.longest_streak', 'DESC')
        .limit(1)
        .getOne(),
      this.badgeRepo.count(),
    ]);

    const topStreaks = await this.getStreakLeaderboard(10);

    // Distribution
    const distribution = await this.streakRepo
      .createQueryBuilder('s')
      .where('s.period = :period', { period: StreakPeriod.DAILY })
      .andWhere('s.current_streak > 0')
      .select([
        "CASE WHEN s.current_streak < 7 THEN '1-6' WHEN s.current_streak < 30 THEN '7-29' WHEN s.current_streak < 100 THEN '30-99' ELSE '100+' END",
        'range',
      ])
      .addSelect('COUNT(*)', 'count')
      .groupBy('range')
      .orderBy('range')
      .getRawMany();

    const streakDistribution = distribution.map((d) => ({
      streak_range: d.range,
      count: parseInt(d.count),
    }));

    return {
      total_users_with_streaks: totalStreaks,
      average_streak: Math.round(parseFloat(avgResult?.avg || 0) * 10) / 10,
      longest_current_streak: longestStreak?.longest_streak || 0,
      total_badges_issued: totalBadges,
      top_streaks: topStreaks,
      streak_distribution: streakDistribution,
    };
  }
}