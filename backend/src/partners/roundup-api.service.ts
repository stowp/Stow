import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { HttpService } from '@nestjs/axios';

import { PartnerTransactionDto } from './dto/partner-transaction.dto';
import {
  PartnerTransaction,
  PartnerTransactionStatus,
} from './entities/partner-transaction.entity';
import { RoundupCalculatorService } from '../savings-roundup/services/roundup-calculator.service';
import { RoundupMethod } from '../savings-roundup/entities/roundup-config.entity';
import { BalanceService } from '../savings/balance.service';
import { ApiKey } from '../auth/entities/api-key.entity';

/** Stroops per whole dollar unit used by NEAREST_DOLLAR. */
const STROOP_PER_UNIT = 10_000_000n;

/**
 * Minimum roundup in minor units to bother depositing.
 * Transactions whose roundup calculates to 0 (already whole)
 * are recorded as SKIPPED but no deposit is made.
 */
const MIN_ROUNDUP = 1n;

export interface RoundupTransactionResult {
  /** Internal record ID */
  id: string;
  partner_transaction_id: string;
  user_reference: string;
  original_amount: string;
  roundup_amount: string;
  currency: string;
  status: PartnerTransactionStatus;
  /** True when this response came from a cached/idempotent replay */
  replayed: boolean;
  created_at: Date;
}

/**
 * Partner Roundup API Service (issue #647)
 *
 * Responsibilities:
 *  1. Idempotency – same (partner_id, partner_transaction_id) pair never
 *     deposits twice; replay returns the original result.
 *  2. Roundup calculation – delegates to the existing
 *     RoundupCalculatorService using NEAREST_DOLLAR (10 M stroops = $1)
 *     by default; configurable via PARTNER_ROUNDUP_UNIT env var.
 *  3. Deposit – calls BalanceService.credit() on the user's account.
 *  4. Webhook – fires an HMAC-signed POST to the partner's callback URL
 *     (read from ApiKey.metadata) fire-and-forget after the deposit; a
 *     webhook failure never rolls back a completed deposit.
 *
 * Integer-only arithmetic: all money is kept as BigInt in stroops.
 */
@Injectable()
export class RoundupApiService {
  private readonly logger = new Logger(RoundupApiService.name);

  /**
   * Minor-unit boundary for rounding.
   * Default: 10_000_000 (stroops per dollar).
   * Override with PARTNER_ROUNDUP_UNIT (integer).
   */
  private readonly roundupUnit: bigint;

  /**
   * Maximum roundup cap per transaction in minor units.
   * Default: 100_000_000 (10 dollars in stroops).
   * Override with PARTNER_ROUNDUP_MAX_AMOUNT.
   */
  private readonly maxRoundupAmount: bigint;

  /** How long to wait for a webhook POST before giving up (ms). */
  private readonly webhookTimeoutMs: number;

  constructor(
    @InjectRepository(PartnerTransaction)
    private readonly txRepository: Repository<PartnerTransaction>,
    private readonly calculator: RoundupCalculatorService,
    private readonly balanceService: BalanceService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    const rawUnit = this.configService.get<number>('PARTNER_ROUNDUP_UNIT');
    this.roundupUnit =
      rawUnit && rawUnit > 0 ? BigInt(rawUnit) : STROOP_PER_UNIT;

    const rawMax = this.configService.get<number>('PARTNER_ROUNDUP_MAX_AMOUNT');
    this.maxRoundupAmount =
      rawMax && rawMax > 0 ? BigInt(rawMax) : 100_000_000n;

    this.webhookTimeoutMs =
      this.configService.get<number>('WEBHOOK_TIMEOUT_MS') ?? 5_000;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Process a partner transaction:
   *   1. Check idempotency (return early if already seen).
   *   2. Calculate round-up using integer arithmetic.
   *   3. If roundup > 0: credit the user's savings balance.
   *   4. Persist the audit record.
   *   5. Fire webhook callback (fire-and-forget).
   */
  async processTransaction(
    apiKey: ApiKey,
    dto: PartnerTransactionDto,
  ): Promise<RoundupTransactionResult> {
    // ── 1. Idempotency ──────────────────────────────────────────────────────
    const existing = await this.txRepository.findOne({
      where: {
        partner_id: apiKey.id,
        partner_transaction_id: dto.partner_transaction_id,
      },
    });

    if (existing) {
      this.logger.debug(
        `Idempotent replay: partner=${apiKey.id} txn=${dto.partner_transaction_id}`,
      );
      return this.toResult(existing, true);
    }

    // ── 2. Calculate round-up ───────────────────────────────────────────────
    const originalAmount = BigInt(dto.amount);
    const roundupAmount = this.calculateRoundup(originalAmount);

    // ── 3. Deposit (only when roundup > 0) ──────────────────────────────────
    const status =
      roundupAmount >= MIN_ROUNDUP
        ? PartnerTransactionStatus.COMPLETED
        : PartnerTransactionStatus.SKIPPED;

    if (status === PartnerTransactionStatus.COMPLETED) {
      await this.balanceService.credit(
        dto.user_reference,
        roundupAmount.toString(),
      );
    }

    // ── 4. Persist audit record ─────────────────────────────────────────────
    const record = await this.persistRecord(
      apiKey,
      dto,
      originalAmount,
      roundupAmount,
      status,
    );

    // ── 5. Webhook (fire-and-forget) ────────────────────────────────────────
    setImmediate(() => {
      void this.dispatchWebhook(apiKey, record);
    });

    return this.toResult(record, false);
  }

  // ---------------------------------------------------------------------------
  // Round-up calculation (integer arithmetic only)
  // ---------------------------------------------------------------------------

  /**
   * Calculates the round-up for `amount` using the configured unit.
   *
   * Rules:
   *  - If amount is already a multiple of the unit → 0 (no roundup).
   *  - Otherwise → (unit − remainder), capped at maxRoundupAmount.
   *  - Result is always ≥ 0.
   */
  calculateRoundup(amount: bigint): bigint {
    return this.calculator.calculateRoundup(
      amount,
      RoundupMethod.NEAREST_DOLLAR,
      undefined,
      this.maxRoundupAmount,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async persistRecord(
    apiKey: ApiKey,
    dto: PartnerTransactionDto,
    originalAmount: bigint,
    roundupAmount: bigint,
    status: PartnerTransactionStatus,
  ): Promise<PartnerTransaction> {
    // Guard against a race where two identical requests arrive concurrently.
    // The unique DB index on (partner_id, partner_transaction_id) will reject
    // the second insert; handle the conflict by returning the winner's record.
    try {
      const record = this.txRepository.create({
        partner_id: apiKey.id,
        partner_transaction_id: dto.partner_transaction_id,
        user_reference: dto.user_reference,
        original_amount: originalAmount.toString(),
        roundup_amount: roundupAmount.toString(),
        currency: dto.currency,
        transaction_timestamp: new Date(dto.timestamp),
        status,
        metadata: dto.metadata ? { ...dto.metadata } : null,
      });
      return await this.txRepository.save(record);
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        // Concurrent duplicate – fetch and return the winner.
        const existing = await this.txRepository.findOne({
          where: {
            partner_id: apiKey.id,
            partner_transaction_id: dto.partner_transaction_id,
          },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * Sends an HMAC-SHA256-signed POST to the partner's webhook URL.
   *
   * The webhook URL and secret are read from ApiKey.metadata:
   *   { webhook_url: string, webhook_secret: string }
   *
   * Payload format:
   * {
   *   event: 'roundup.completed' | 'roundup.skipped',
   *   timestamp: <ISO 8601>,
   *   data: { ...RoundupTransactionResult fields }
   * }
   *
   * Signature header: X-Webhook-Signature: <hmac-sha256-hex>
   * The HMAC is computed over JSON.stringify(payload).
   *
   * Failures are logged but never propagated — a slow or unreachable
   * webhook must not undo a completed deposit.
   */
  private async dispatchWebhook(
    apiKey: ApiKey,
    record: PartnerTransaction,
  ): Promise<void> {
    // metadata is typed as string[] on ApiKey but callers may store
    // stringified JSON in name or we use a convention: check if
    // apiKey has extended metadata stored externally.
    // We read webhook config from ConfigService using the key prefix
    // pattern PARTNER_<PARTNER_ID>_WEBHOOK_URL / _SECRET, falling
    // back to the global PARTNER_WEBHOOK_URL / PARTNER_WEBHOOK_SECRET.
    const partnerId = apiKey.id.replace(/-/g, '_').toUpperCase();

    const webhookUrl =
      this.configService.get<string>(`PARTNER_${partnerId}_WEBHOOK_URL`) ??
      this.configService.get<string>('PARTNER_WEBHOOK_URL');

    const webhookSecret =
      this.configService.get<string>(`PARTNER_${partnerId}_WEBHOOK_SECRET`) ??
      this.configService.get<string>('PARTNER_WEBHOOK_SECRET');

    if (!webhookUrl) {
      // No webhook configured for this partner — nothing to do.
      return;
    }

    const event =
      record.status === PartnerTransactionStatus.COMPLETED
        ? 'roundup.completed'
        : 'roundup.skipped';

    const payload = {
      event,
      timestamp: new Date().toISOString(),
      data: {
        id: record.id,
        partner_transaction_id: record.partner_transaction_id,
        user_reference: record.user_reference,
        original_amount: record.original_amount,
        roundup_amount: record.roundup_amount,
        currency: record.currency,
        status: record.status,
        created_at: record.created_at,
      },
    };

    const payloadStr = JSON.stringify(payload);
    const signature = webhookSecret
      ? crypto
          .createHmac('sha256', webhookSecret)
          .update(payloadStr)
          .digest('hex')
      : '';

    try {
      await this.httpService.axiosRef.post(webhookUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Event': event,
          'X-Webhook-Signature': signature,
          'X-Webhook-Timestamp': payload.timestamp,
        },
        timeout: this.webhookTimeoutMs,
      });
      this.logger.debug(
        `Webhook delivered: partner=${apiKey.id} event=${event}`,
      );
    } catch (err: unknown) {
      // Log but never throw — deposit is already committed.
      this.logger.warn(
        `Webhook delivery failed for partner=${apiKey.id} txn=${record.partner_transaction_id}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private toResult(
    record: PartnerTransaction,
    replayed: boolean,
  ): RoundupTransactionResult {
    return {
      id: record.id,
      partner_transaction_id: record.partner_transaction_id,
      user_reference: record.user_reference,
      original_amount: record.original_amount,
      roundup_amount: record.roundup_amount,
      currency: record.currency,
      status: record.status,
      replayed,
      created_at: record.created_at,
    };
  }
}
