import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

export enum PendingWithdrawalStatus {
  PENDING = 'pending',
  CLAIMED = 'claimed',
  CANCELLED = 'cancelled',
}

/**
 * A yield-adapter withdrawal request, projected from the `withdraw_requested`
 * event and updated in place by `withdraw_claimed` / `withdraw_cancelled`.
 * Kept queryable while `status` is `pending` so the frontend can show a
 * cooldown countdown before `claimable_at`.
 */
@Entity('pending_withdrawals')
@Index(['status'])
export class PendingWithdrawal {
  @PrimaryGeneratedColumn('uuid')
  @ApiProperty()
  id: string;

  /** The yield-adapter's own withdrawal-request id (from event data). */
  @Column({ type: 'varchar', unique: true })
  @ApiProperty()
  request_id: string;

  /** Stellar account address of the requester. */
  @Column({ type: 'varchar' })
  @ApiProperty()
  owner: string;

  /** Shares burned at request time, kept as a string to avoid JS number precision loss. */
  @Column({ type: 'varchar' })
  @ApiProperty()
  shares: string;

  @Column({ type: 'timestamptz' })
  @ApiProperty()
  claimable_at: Date;

  @Column({
    type: 'enum',
    enum: PendingWithdrawalStatus,
    default: PendingWithdrawalStatus.PENDING,
  })
  @ApiProperty({ enum: PendingWithdrawalStatus })
  status: PendingWithdrawalStatus;

  @Column({ type: 'timestamptz', nullable: true })
  @ApiProperty()
  cancelled_at: Date | null;

  @CreateDateColumn()
  @ApiProperty()
  created_at: Date;

  @UpdateDateColumn()
  @ApiProperty()
  updated_at: Date;
}
