import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  DeleteDateColumn,
} from 'typeorm';

export enum NotificationType {
  GoalReached = 'goal_reached',
  LockUnlocked = 'lock_unlocked',
  GroupSettled = 'group_settled',
  Deposit = 'deposit',
}

@Entity('notifications')
@Index(['user_address'])
@Index(['type'])
@Index(['read'])
@Index(['created_at'])
@Index(['user_address', 'read', 'created_at'])
export class Notification {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar' })
  user_address: string;

  @Column({ type: 'varchar' })
  type: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false })
  read: boolean;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @DeleteDateColumn()
  deleted_at: Date | null;
}
