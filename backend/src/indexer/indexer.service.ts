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
  private depositsProcessed = 0;
  private withdrawalsProcessed = 0;
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
      this.recordProcessed(event.event_type);
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
   * Decode a savings-vault event and apply its side effects (update savings
   * balances, mark goals reached, record group settlements, etc.) via the
   * shared savings-projection service.
   */
  private async decodeAndApply(event: ContractEvent): Promise<void> {
    await this.savingsProjectionService.apply(
      event.event_type,
      event.data ?? {},
    );
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
    } as unknown as Record<string, unknown>);
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
    const [pending, failed, dlq] = await Promise.all([
      this.contractEventRepository.count({
        where: { status: ContractEventStatus.PENDING },
      }),
      this.contractEventRepository.count({
        where: { status: ContractEventStatus.FAILED },
      }),
      this.contractEventRepository.count({
        where: { status: ContractEventStatus.DLQ },
      }),
    ]);
    const lastLedger = await this.getCheckpoint(CHECKPOINT_LEDGER_KEY);
    const latestLedger = await this.getCheckpoint(CHECKPOINT_LEDGER_KEY_LATEST);
    return {
      events_per_second: this.getEventsProcessedPerMinute() / 60,
      lag_in_ledgers: Math.max(latestLedger - lastLedger, 0),
      total_events_processed: this.eventsProcessed,
      deposits_processed: this.depositsProcessed,
      withdrawals_processed: this.withdrawalsProcessed,
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

  private recordProcessed(eventType: string): void {
    this.eventsProcessed += 1;
    if (eventType === 'deposit') this.depositsProcessed += 1;
    if (eventType === 'withdraw') this.withdrawalsProcessed += 1;
    this.lastProcessedAt = Date.now();
    this.eventTimestamps.push(this.lastProcessedAt);
  }
}
