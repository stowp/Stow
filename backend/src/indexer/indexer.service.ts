import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LessThan, Repository } from 'typeorm';
import {
  ContractEvent,
  ContractEventStatus,
} from './entities/contract-event.entity';
import { FeeHistory } from './entities/fee-history.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import {
  PendingWithdrawal,
  PendingWithdrawalStatus,
} from './entities/pending-withdrawal.entity';
import { HarvestHistory } from './entities/harvest-history.entity';
import { IndexerMetricsDto } from './dto/indexer-metrics.dto';
import { BackfillResponseDto } from './dto/backfill.dto';
import { ReconciliationService } from './reconciliation.service';
import { SorobanService } from '../soroban/soroban.service';
import { SavingsProjectionService } from '../savings-projection/savings-projection.service';

export const CHECKPOINT_LEDGER_KEY = 'indexer:last_processed_ledger';
const CHECKPOINT_LEDGER_KEY_LATEST = 'indexer:latest_contract_ledger';
const MAX_RETRIES = 5;
const BATCH_SIZE = 100;
const BACKFILL_MAX_PAGES = 1000;

/**
 * Indexes on-chain events emitted by the Stow savings-vault contract into the
 * `contract_events` store, applies them to the savings projections via
 * `SavingsProjectionService`, and exposes read/replay/metrics APIs.
 */
@Injectable()
export class IndexerService implements OnModuleInit {
  private readonly logger = new Logger(IndexerService.name);
  private isRunning = false;
  private startTime: number = Date.now();
  private eventsProcessed = 0;
  private lastProcessedAt = Date.now();
  private eventTimestamps: number[] = [];

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(ContractEvent)
    private readonly contractEventRepository: Repository<ContractEvent>,
    @InjectRepository(FeeHistory)
    private readonly feeHistoryRepository: Repository<FeeHistory>,
    @InjectRepository(IndexerCheckpoint)
    private readonly checkpointRepository: Repository<IndexerCheckpoint>,
    @InjectRepository(PendingWithdrawal)
    private readonly pendingWithdrawalRepository: Repository<PendingWithdrawal>,
    @InjectRepository(HarvestHistory)
    private readonly harvestHistoryRepository: Repository<HarvestHistory>,
    private readonly reconciliationService: ReconciliationService,
    private readonly sorobanService: SorobanService,
    private readonly savingsProjectionService: SavingsProjectionService,
  ) {}

  async onModuleInit(): Promise<void> {
    const last = await this.getCheckpoint(CHECKPOINT_LEDGER_KEY);
    this.logger.log(`Indexer initialized at ledger ${last}`);
  }

  // --- polling ------------------------------------------------------------

  @Cron(CronExpression.EVERY_30_SECONDS)
  async pollContractEvents(): Promise<void> {
    const contractId = this.configService.get<string>('SOROBAN_CONTRACT_ID');
    if (!contractId || contractId === 'your-contract-id-here') {
      return; // Skip until the savings-vault contract is deployed.
    }
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.fetchAndPersistEvents();
      await this.processPendingBatch();
    } catch (err) {
      this.logger.error('pollContractEvents failed', err as Error);
    } finally {
      this.isRunning = false;
    }
  }

  async fetchAndPersistEvents(): Promise<number> {
    const lastProcessed = await this.getCheckpoint(CHECKPOINT_LEDGER_KEY);
    const startLedger = lastProcessed > 0 ? lastProcessed + 1 : 1;

    const { events, latestLedger } =
      await this.sorobanService.getEvents(startLedger);

    const safeLatestLedger =
      typeof latestLedger === 'number' ? latestLedger : lastProcessed;
    if (safeLatestLedger > 0) {
      await this.setCheckpoint(CHECKPOINT_LEDGER_KEY_LATEST, safeLatestLedger);
    }

    let persistedCount = 0;
    let maxEventLedger = lastProcessed;

    for (let index = 0; index < events.length; index++) {
      const rpcEvent = events[index];
      const logIndex = index;

      const existing = await this.contractEventRepository.findOne({
        where: { ledger: rpcEvent.ledger, log_index: logIndex },
      });

      if (!existing) {
        const eventType =
          rpcEvent.topic && rpcEvent.topic.length > 0
            ? rpcEvent.topic[0]
            : 'unknown';

        const contractEvent = this.contractEventRepository.create({
          ledger: rpcEvent.ledger,
          log_index: logIndex,
          event_type: eventType,
          data: rpcEvent.value,
          tx_hash: rpcEvent.txHash ?? null,
          status: ContractEventStatus.PENDING,
          retry_count: 0,
        });

        await this.contractEventRepository.save(contractEvent);
        persistedCount++;
      }

      if (rpcEvent.ledger > maxEventLedger) {
        maxEventLedger = rpcEvent.ledger;
      }
    }

    const newCheckpoint =
      events.length > 0
        ? Math.max(maxEventLedger, safeLatestLedger)
        : Math.max(lastProcessed, safeLatestLedger);

    if (newCheckpoint > lastProcessed) {
      await this.setCheckpoint(CHECKPOINT_LEDGER_KEY, newCheckpoint);
    }

    return persistedCount;
  }

  private async processPendingBatch(): Promise<void> {
    const pending = await this.contractEventRepository.find({
      where: { status: ContractEventStatus.PENDING },
      order: { ledger: 'ASC' },
      take: BATCH_SIZE,
    });
    for (const event of pending) {
      await this.applyEvent(event);
    }
  }

  private async applyEvent(event: ContractEvent): Promise<void> {
    try {
      await this.decodeAndApply(event);
      event.status = ContractEventStatus.PROCESSED;
      await this.contractEventRepository.save(event);
      this.recordProcessed();
    } catch (err) {
      event.retry_count = (event.retry_count ?? 0) + 1;
      event.status =
        event.retry_count >= MAX_RETRIES
          ? ContractEventStatus.DLQ
          : ContractEventStatus.FAILED;
      await this.contractEventRepository.save(event);
      this.logger.warn(`Event ${event.id} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Decode an event and apply its side effects. Yield-adapter topics are
   * handled directly here (see `applyWithdrawRequested` / `applyWithdrawCancelled`
   * / `applyHarvested`); everything else is a savings-vault topic, routed to
   * the shared savings-projection service (update savings balances, mark
   * goals reached, record group settlements, etc.).
   */
  private async decodeAndApply(event: ContractEvent): Promise<void> {
    switch (event.event_type) {
      case 'withdraw_requested':
        await this.applyWithdrawRequested(event);
        return;
      case 'withdraw_cancelled':
        await this.applyWithdrawCancelled(event);
        return;
      case 'harvested':
        await this.applyHarvested(event);
        return;
      default:
        await this.savingsProjectionService.apply(
          event.event_type,
          event.data ?? {},
        );
    }
  }

  /**
   * Decode a yield-adapter `withdraw_requested` event into a queryable
   * pending-withdrawal record, keyed by the adapter's own request id so a
   * replayed event upserts rather than duplicates.
   */
  private async applyWithdrawRequested(event: ContractEvent): Promise<void> {
    const data = event.data ?? {};
    const requestId = String(data.id ?? data.request_id);

    const existing = await this.pendingWithdrawalRepository.findOne({
      where: { request_id: requestId },
    });
    if (existing) return;

    await this.pendingWithdrawalRepository.save(
      this.pendingWithdrawalRepository.create({
        request_id: requestId,
        owner: String(data.owner),
        shares: String(data.shares),
        claimable_at: this.toDate(data.claimable_at),
        status: PendingWithdrawalStatus.PENDING,
      }),
    );
  }

  /**
   * Decode a yield-adapter `withdraw_cancelled` event: mark the matching
   * pending-withdrawal record cancelled, distinct from claimed. A no-op if
   * the originating `withdraw_requested` hasn't been indexed yet (e.g. out
   * of order delivery); the retry/backfill path will catch it up.
   */
  private async applyWithdrawCancelled(event: ContractEvent): Promise<void> {
    const data = event.data ?? {};
    const requestId = String(data.id ?? data.request_id);

    await this.pendingWithdrawalRepository.update(
      { request_id: requestId },
      {
        status: PendingWithdrawalStatus.CANCELLED,
        cancelled_at: new Date(),
      },
    );
  }

  /**
   * Decode a yield-adapter `harvested` event into a harvest-history record,
   * preserving the signed delta (positive yield, negative loss) and the fee
   * taken (`0` on a loss).
   */
  private async applyHarvested(event: ContractEvent): Promise<void> {
    const data = event.data ?? {};

    await this.harvestHistoryRepository.save(
      this.harvestHistoryRepository.create({
        delta: this.stringifyStroops(data.delta),
        fee: this.stringifyStroops(data.fee, '0'),
        harvested_at: this.toDate(data.timestamp),
        ledger: event.ledger,
        tx_hash: event.tx_hash,
      }),
    );
  }

  /**
   * Renders a decoded contract event's stroop-amount field (i128, so kept
   * as a string rather than a JS `number` to avoid precision loss) as a
   * string. `fallback` is used only when `value` is absent
   * (`undefined`/`null`); a present value of the wrong type (e.g. an
   * object, where the RPC's XDR decoding produced something unexpected)
   * throws instead of silently rendering `'[object Object]'` or being
   * swapped for the fallback, so a malformed event fails loudly rather
   * than masquerading as a valid zero amount.
   */
  private stringifyStroops(value: unknown, fallback?: string): string {
    if (value === undefined || value === null) {
      if (fallback === undefined) {
        throw new Error(
          'stringifyStroops: value is missing and no fallback was given',
        );
      }
      return fallback;
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    throw new Error(
      `stringifyStroops: unexpected type ${typeof value} for a stroop-amount field`,
    );
  }

  /**
   * Converts a contract event field carrying a Soroban `u64` ledger
   * timestamp in whole seconds since the Unix epoch — decoded as a JS
   * `number`, `string`, or `bigint` depending on the XDR normalization step
   * upstream — into a `Date`.
   */
  private toDate(value: unknown): Date {
    const seconds =
      typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
    return new Date(seconds * 1000);
  }

  // --- replay / maintenance ----------------------------------------------

  async reindex(fromLedger: number): Promise<void> {
    await this.setCheckpoint(CHECKPOINT_LEDGER_KEY, fromLedger);
    this.logger.log(`Reindex requested from ledger ${fromLedger}`);
  }

  async triggerManualSync(): Promise<void> {
    await this.pollContractEvents();
  }

  async backfillEvents(
    fromLedger: number,
    toLedger: number,
  ): Promise<BackfillResponseDto> {
    this.logger.log(`Backfill requested ${fromLedger}..${toLedger}`);
    let totalFetched = 0;
    let newlyProcessed = 0;
    let alreadyIndexed = 0;
    let errors = 0;

    try {
      let cursor = fromLedger;
      let pages = 0;

      while (cursor <= toLedger && pages < BACKFILL_MAX_PAGES) {
        pages++;

        const { events } = await this.sorobanService.getEvents(cursor);
        if (events.length === 0) break;

        const inRangeEvents = events.filter(
          (e) => e.ledger >= fromLedger && e.ledger <= toLedger,
        );
        totalFetched += inRangeEvents.length;

        for (let index = 0; index < inRangeEvents.length; index++) {
          const rpcEvent = inRangeEvents[index];
          const logIndex = index;

          const existing = await this.contractEventRepository.findOne({
            where: { ledger: rpcEvent.ledger, log_index: logIndex },
          });

          if (existing) {
            alreadyIndexed++;
          } else {
            try {
              const eventType =
                rpcEvent.topic && rpcEvent.topic.length > 0
                  ? rpcEvent.topic[0]
                  : 'unknown';

              const contractEvent = this.contractEventRepository.create({
                ledger: rpcEvent.ledger,
                log_index: logIndex,
                event_type: eventType,
                data: rpcEvent.value,
                tx_hash: rpcEvent.txHash ?? null,
                status: ContractEventStatus.PENDING,
                retry_count: 0,
              });

              await this.contractEventRepository.save(contractEvent);
              await this.applyEvent(contractEvent);
              newlyProcessed++;
            } catch {
              errors++;
            }
          }
        }

        const maxLedgerInPage = Math.max(...events.map((e) => e.ledger));
        if (maxLedgerInPage < cursor) break; // no progress; avoid looping forever
        cursor = maxLedgerInPage + 1;
      }
    } catch (err) {
      this.logger.error(
        `Backfill failed for ${fromLedger}..${toLedger}`,
        err as Error,
      );
    }

    return {
      total_fetched: totalFetched,
      newly_processed: newlyProcessed,
      already_indexed: alreadyIndexed,
      errors,
      from_ledger: fromLedger,
      to_ledger: toLedger,
    };
  }

  async retryFailedEvents(): Promise<number> {
    const failed = await this.contractEventRepository.find({
      where: { status: ContractEventStatus.FAILED },
      take: BATCH_SIZE,
    });
    for (const event of failed) {
      event.status = ContractEventStatus.PENDING;
      await this.contractEventRepository.save(event);
    }
    return failed.length;
  }

  async cleanupOldEvents(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.contractEventRepository.delete({
      status: ContractEventStatus.PROCESSED,
      created_at: LessThan(cutoff),
    });
    return result.affected ?? 0;
  }

  // --- reads / metrics ----------------------------------------------------

  async getEventsPaginated(cursor?: string, limit = 50) {
    const qb = this.contractEventRepository
      .createQueryBuilder('e')
      .orderBy('e.ledger', 'DESC')
      .take(limit + 1);
    if (cursor) {
      qb.where('e.id < :cursor', { cursor });
    }
    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      next_cursor: hasMore ? items[items.length - 1]?.id : null,
    };
  }

  async getMetrics(): Promise<IndexerMetricsDto> {
    const [pending, failed, dlq, total] = await Promise.all([
      this.contractEventRepository.count({
        where: { status: ContractEventStatus.PENDING },
      }),
      this.contractEventRepository.count({
        where: { status: ContractEventStatus.FAILED },
      }),
      this.contractEventRepository.count({
        where: { status: ContractEventStatus.DLQ },
      }),
      this.contractEventRepository.count(),
    ]);
    const lastLedger = await this.getCheckpoint(CHECKPOINT_LEDGER_KEY);
    const latestLedger = await this.getCheckpoint(CHECKPOINT_LEDGER_KEY_LATEST);
    return {
      events_per_second: this.getEventsProcessedPerMinute() / 60,
      lag_in_ledgers: Math.max(latestLedger - lastLedger, 0),
      total_events_processed: total,
      pending_events: pending,
      failed_events: failed,
      dlq_events: dlq,
      last_processed_ledger: lastLedger,
      latest_contract_ledger: latestLedger,
      is_running: this.isRunning,
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  getEventsProcessedPerMinute(): number {
    const cutoff = Date.now() - 60_000;
    this.eventTimestamps = this.eventTimestamps.filter((t) => t > cutoff);
    return this.eventTimestamps.length;
  }

  getLastSuccessfulSyncTimestamp(): Date {
    return new Date(this.lastProcessedAt);
  }

  // --- checkpoints --------------------------------------------------------

  private async getCheckpoint(key: string): Promise<number> {
    const row = await this.checkpointRepository.findOne({ where: { key } });
    return row ? Number(row.value) : 0;
  }

  private async setCheckpoint(key: string, value: number): Promise<void> {
    await this.checkpointRepository.save({ key, value });
  }

  private recordProcessed(): void {
    this.eventsProcessed += 1;
    this.lastProcessedAt = Date.now();
    this.eventTimestamps.push(this.lastProcessedAt);
  }
}
