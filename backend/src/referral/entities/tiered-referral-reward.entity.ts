import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum TierLevel {
  TIER_1 = 1, // 1-4 referrals
  TIER_2 = 2, // 5-9 referrals
  TIER_3 = 3, // 10+ referrals
}

@Entity('tiered_referral_rewards')
@Index(['user_id'])
@Index(['tier'])
export class TieredReferralReward {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'int', default: 0 })
  total_referrals: number;

  @Column({ type: 'enum', enum: TierLevel, default: TierLevel.TIER_1 })
  tier: TierLevel;

  @Column({ type: 'varchar' })
  tier_name: string;

  @Column({ type: 'varchar', default: '0' })
  bonus_amount_stroops: string;

  @Column({ type: 'boolean', default: false })
  bonus_awarded: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  tier_reached_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  bonus_awarded_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  // Computed properties (not stored)
  tier_multiplier?: number;
  next_tier?: TierLevel;
  referrals_to_next_tier?: number;
}

export const TIER_CONFIG: Record<TierLevel, { name: string; multiplier: number; threshold: number; bonus_stroops: string }> = {
  [TierLevel.TIER_1]: { 
    name: 'Bronze', 
    multiplier: 1.0, 
    threshold: 0,
    bonus_stroops: '0',
  },
  [TierLevel.TIER_2]: { 
    name: 'Silver', 
    multiplier: 1.5, 
    threshold: 5,
    bonus_stroops: '1000000', // 1 XLM bonus
  },
  [TierLevel.TIER_3]: { 
    name: 'Gold', 
    multiplier: 2.0, 
    threshold: 10,
    bonus_stroops: '5000000', // 5 XLM bonus
  },
};