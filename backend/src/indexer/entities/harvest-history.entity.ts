import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

/**
 * One record per on-chain `harvested` event from the yield-adapter. `delta`
 * is signed: positive on a yield report, negative on a loss (mirrors
 * `harvest::harvest`'s doc comment in `contracts/yield-adapter`). `fee` is
 * always `'0'` on a loss — see `harvest::apply_performance_fee`.
 */
@Entity('harvest_history')
export class HarvestHistory {
  @PrimaryGeneratedColumn('uuid')
  @ApiProperty()
  id: string;

  /** Signed stroop delta, kept as a string to avoid JS number precision loss. */
  @Column({ type: 'varchar' })
  @ApiProperty()
  delta: string;

  /** Stroop performance fee taken on this harvest; `'0'` on a loss. */
  @Column({ type: 'varchar', default: '0' })
  @ApiProperty()
  fee: string;

  @Column({ type: 'timestamptz' })
  @ApiProperty()
  harvested_at: Date;

  @Column({ type: 'bigint', nullable: true })
  @ApiProperty()
  ledger: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @ApiProperty()
  tx_hash: string | null;

  @CreateDateColumn()
  @ApiProperty()
  created_at: Date;
}
