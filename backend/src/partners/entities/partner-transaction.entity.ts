import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum PartnerTransactionStatus {
  COMPLETED = 'completed',
  SKIPPED = 'skipped', // amount already whole – roundup was 0
}

/**
 * Audit record of every partner roundup transaction processed by the API.
 *
 * The (partner_id, partner_transaction_id) unique index is the idempotency
 * gate: the service inserts a row only once and returns the stored result
 * on replay.
 */
@Entity('partner_roundup_transactions')
@Index(['partner_id', 'partner_transaction_id'], { unique: true })
@Index(['user_reference'])
@Index(['created_at'])
export class PartnerTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** ID of the ApiKey entity that authenticated this request. */
  @Column({ type: 'uuid' })
  partner_id: string;

  /** Partner-supplied idempotency key. */
  @Column({ type: 'varchar', length: 128 })
  partner_transaction_id: string;

  /** Platform user reference supplied by the partner. */
  @Column({ type: 'varchar', length: 256 })
  user_reference: string;

  /** Original transaction amount in minor units, stored as string to preserve precision. */
  @Column({ type: 'varchar' })
  original_amount: string;

  /** Calculated round-up amount in minor units. '0' when amount was already whole. */
  @Column({ type: 'varchar' })
  roundup_amount: string;

  /** ISO 4217 currency code. */
  @Column({ type: 'varchar', length: 4 })
  currency: string;

  /** Partner-reported transaction timestamp. */
  @Column({ type: 'timestamptz' })
  transaction_timestamp: Date;

  @Column({
    type: 'varchar',
    enum: PartnerTransactionStatus,
    default: PartnerTransactionStatus.COMPLETED,
  })
  status: PartnerTransactionStatus;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
