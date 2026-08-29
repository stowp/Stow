import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Per-account savings balance projected from the vault contract's `deposit`
 * and `withdraw` events.
 */
@Entity('balances')
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Stellar account address. */
  @Column({ type: 'varchar', unique: true })
  account: string;

  /** Stroop amount, kept as a string to avoid JS number precision loss. */
  @Column({ type: 'varchar', default: '0' })
  amount: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
