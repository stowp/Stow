import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum StreakPeriod {
  DAILY = 'daily',
  WEEKLY = 'weekly',
}

export enum BadgeType {
  STREAK_7_DAYS = 'streak_7_days',
  STREAK_14_DAYS = 'streak_14_days',
  STREAK_30_DAYS = 'streak_30_days',
  STREAK_60_DAYS = 'streak_60_days',
  STREAK_100_DAYS = 'streak_100_days',
  STREAK_180_DAYS = 'streak_180_days',
  STREAK_365_DAYS = 'streak_365_days',
  FIRST_DEPOSIT = 'first_deposit',
  DEPOSIT_MASTER = 'deposit_master',
  SAVING_CHAMPION = 'saving_champion',
}

@Entity('savings_streaks')
@Index(['user_id'])
@Index(['period'])
@Index(['current_streak'], { where: "current_streak > 0" })
export class SavingsStreak {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: StreakPeriod, default: StreakPeriod.DAILY })
  period: StreakPeriod;

  @Column({ type: 'int', default: 0 })
  current_streak: number;

  @Column({ type: 'int', default: 0 })
  longest_streak: number;

  @Column({ type: 'timestamptz', nullable: true })
  last_deposit_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  streak_start_date: Date | null;

  @Column({ type: 'boolean', default: false })
  streak_broken: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  reminder_sent_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  streak_broken_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

@Entity('savings_badges')
@Index(['user_id'])
@Index(['badge_type'])
@Index(['earned_at'])
export class SavingsBadge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: BadgeType })
  badge_type: BadgeType;

  @Column({ type: 'varchar' })
  badge_name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', nullable: true })
  icon: string | null;

  @Column({ type: 'int', nullable: true })
  streak_milestone: number | null;

  @Column({ type: 'timestamptz' })
  earned_at: Date;

  @CreateDateColumn()
  created_at: Date;
}

export const BADGE_CONFIG: Record<BadgeType, { name: string; description: string; icon: string; streak_milestone?: number }> = {
  [BadgeType.FIRST_DEPOSIT]: {
    name: 'First Deposit',
    description: 'Made your first deposit',
    icon: 'trophy',
  },
  [BadgeType.STREAK_7_DAYS]: {
    name: '7-Day Streak',
    description: 'Saved for 7 consecutive days',
    icon: 'flame',
    streak_milestone: 7,
  },
  [BadgeType.STREAK_14_DAYS]: {
    name: '14-Day Streak',
    description: 'Saved for 14 consecutive days',
    icon: 'flame',
    streak_milestone: 14,
  },
  [BadgeType.STREAK_30_DAYS]: {
    name: '30-Day Streak',
    description: 'Saved for 30 consecutive days',
    icon: 'star',
    streak_milestone: 30,
  },
  [BadgeType.STREAK_60_DAYS]: {
    name: '60-Day Streak',
    description: 'Saved for 60 consecutive days',
    icon: 'medal',
    streak_milestone: 60,
  },
  [BadgeType.STREAK_100_DAYS]: {
    name: '100-Day Streak',
    description: 'Saved for 100 consecutive days',
    icon: 'crown',
    streak_milestone: 100,
  },
  [BadgeType.STREAK_180_DAYS]: {
    name: '180-Day Streak',
    description: 'Saved for 180 consecutive days',
    icon: 'diamond',
    streak_milestone: 180,
  },
  [BadgeType.STREAK_365_DAYS]: {
    name: '365-Day Streak',
    description: 'Saved for 365 consecutive days',
    icon: 'legend',
    streak_milestone: 365,
  },
  [BadgeType.DEPOSIT_MASTER]: {
    name: 'Deposit Master',
    description: 'Completed 50 deposits',
    icon: 'master',
  },
  [BadgeType.SAVING_CHAMPION]: {
    name: 'Saving Champion',
    description: 'Reached $10,000 in total savings',
    icon: 'champion',
  },
};