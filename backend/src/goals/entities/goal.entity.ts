import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum GoalStatus {
  ACTIVE = 'active',
  REACHED = 'reached',
  CLAIMED = 'claimed',
}

/**
 * A savings goal projected from the vault contract's `goal_created`,
 * `goal_contributed`, and `goal_reached` events.
 */
@Entity('goals')
@Index(['owner'])
export class Goal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The contract's identifier for this goal (from event data). */
  @Column({ type: 'varchar', unique: true })
  on_chain_id: string;

  /** Stellar account address of the goal owner. */
  @Column({ type: 'varchar' })
  owner: string;

  @Column({ type: 'varchar' })
  name: string;

  /** Stroop amount, kept as a string to avoid JS number precision loss. */
  @Column({ type: 'varchar' })
  target_amount: string;

  @Column({ type: 'varchar', default: '0' })
  current_amount: string;

  @Column({ type: 'enum', enum: GoalStatus, default: GoalStatus.ACTIVE })
  status: GoalStatus;

  @Column({ type: 'timestamptz', nullable: true })
  reached_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
