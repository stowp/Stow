import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum AccountType {
  FLEXIBLE = 'flexible',
  LOCKED_30 = 'locked_30',
  LOCKED_60 = 'locked_60',
  LOCKED_90 = 'locked_90',
  LOCKED_180 = 'locked_180',
  LOCKED_365 = 'locked_365',
  YIELD = 'yield',
}

@Entity('account_types')
export class AccountTypeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, type: 'varchar' })
  type: AccountType;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', nullable: true })
  icon: string | null;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  apy: number;

  @Column({ type: 'int', nullable: true })
  lock_period_days: number | null;

  @Column({ type: 'boolean', default: false })
  allows_withdrawal: boolean;

  @Column({ type: 'boolean', default: false })
  early_withdrawal_penalty: boolean;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  early_withdrawal_penalty_percent: number;

  @Column({ type: 'varchar', nullable: true })
  minimum_deposit: string | null;

  @Column({ type: 'varchar', nullable: true })
  maximum_deposit: string | null;

  @Column({ type: 'jsonb', default: [] })
  features: string[];

  @Column({ type: 'jsonb', default: [] })
  pros: string[];

  @Column({ type: 'jsonb', default: [] })
  cons: string[];

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @Column({ type: 'int', default: 0 })
  sort_order: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}