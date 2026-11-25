import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('user_preferences')
export class UserPreferences {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ default: true })
  email_notifications: boolean;

  @Column({ default: false })
  marketing_emails: boolean;

  /** A savings goal the user created reached a milestone or was created. */
  @Column({ default: true })
  goal_created_notifications: boolean;

  /** Someone contributed to a savings goal the user owns or participates in. */
  @Column({ default: true })
  goal_contribution_notifications: boolean;

  /** A savings goal reached a milestone (25%, 50%, 75%). */
  @Column({ default: true })
  goal_milestone_notifications: boolean;

  /** A savings goal reached its target amount. */
  @Column({ default: true })
  goal_reached_notifications: boolean;

  /** Yield was earned from a harvest event. */
  @Column({ default: true })
  yield_earned_notifications: boolean;

  /** A deposit into a savings vault was confirmed. */
  @Column({ default: true })
  deposit_notifications: boolean;

  /** A locked savings plan passed its unlock time and can be withdrawn. */
  @Column({ default: true })
  withdrawal_notifications: boolean;

  /** A group savings pool was settled and paid out to members. */
  @Column({ default: true })
  group_settlement_notifications: boolean;

  @Column({ type: 'varchar', default: 'off' })
  digest_frequency: 'daily' | 'weekly' | 'off';

  /** Delivery hour (0-23) in the user's local time, per `digest_timezone`. */
  @Column({ type: 'int', default: 8 })
  digest_hour: number;

  /** IANA timezone name (e.g. "America/Chicago", "Europe/Lagos"). */
  @Column({ type: 'varchar', default: 'UTC' })
  digest_timezone: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
