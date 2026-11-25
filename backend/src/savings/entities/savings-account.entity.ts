import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Flexible savings account balance projected from the indexer's
 * `deposit` and `withdraw` events for each owner address.
 *
 * One row per owner — upserted by the indexer as events arrive.
 */
@Entity('savings_accounts')
@Index(['owner'])
export class SavingsAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Stellar account address of the account owner. */
  @Column({ type: 'varchar', unique: true })
  owner: string;

  /**
   * Flexible (unlocked) balance in stroops.
   * Stored as a string to avoid JS number precision loss on large i128 values.
   */
  @Column({ type: 'varchar', default: '0' })
  balance: string;

  /** Set when this account is merged into another; archived accounts are read-only. */
  @Column({ type: 'timestamptz', nullable: true })
  archived_at: Date | null;

  /** Owner address that received this account's balance, once archived. */
  @Column({ type: 'varchar', nullable: true })
  merged_into: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
