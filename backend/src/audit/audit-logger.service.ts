import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'crypto';
import {
  Between,
  FindOptionsWhere,
  ILike,
  LessThan,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';

export interface AuditEntryInput {
  /** The authenticated user, if any. */
  userId?: string | null;
  action: string;
  method?: string | null;
  endpoint?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** An audit entry with its encrypted fields decrypted, for admins. */
export interface AuditEntryView {
  id: string;
  createdAt: Date;
  userId: string | null;
  action: string;
  method: string | null;
  endpoint: string | null;
  statusCode: number | null;
  durationMs: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  /** True if an encrypted field could not be decrypted (wrong key or tampering). */
  decryptionFailed: boolean;
}

export interface AuditFilters {
  userId?: string;
  /** Matches actions containing this text. */
  action?: string;
  /** Matches endpoints containing this text. */
  endpoint?: string;
  method?: string;
  statusCode?: number;
  /** Exact client IP; matched through the keyed hash, never by decrypting. */
  ip?: string;
  from?: Date;
  to?: Date;
}

export interface AuditSearchResult {
  items: AuditEntryView[];
  total: number;
  page: number;
  limit: number;
}

export interface AccessPattern {
  method: string | null;
  endpoint: string;
  requests: number;
  uniqueUsers: number;
  errors: number;
  averageDurationMs: number;
  lastAccessedAt: Date;
}

export class AuditConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditConfigError';
  }
}

export const DEFAULT_RETENTION_DAYS = 365;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
/** Hard cap on one CSV export so a single request cannot exhaust memory. */
export const MAX_EXPORT_ROWS = 50_000;
const EXPORT_BATCH_SIZE = 1_000;

const FIELD_IP = 'ip_address';
const FIELD_USER_AGENT = 'user_agent';
const FIELD_METADATA = 'metadata';
const FORMAT_VERSION = 'v1';

const MAX_ACTION_LENGTH = 255;
const MAX_ENDPOINT_LENGTH = 512;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_STRING_VALUE = 500;
const MAX_ARRAY_ITEMS = 50;
const MAX_DEPTH = 4;
const REDACTED = '[REDACTED]';

/** Keys whose values must never reach the audit log, even encrypted. */
const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|authorization|api[-_]?key|signature|mnemonic|seed|private|cookie|credential|otp|pin$/i;

const CSV_COLUMNS = [
  'id',
  'timestamp',
  'userId',
  'action',
  'method',
  'endpoint',
  'statusCode',
  'durationMs',
  'ipAddress',
  'userAgent',
  'metadata',
] as const;

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Strips the IPv4-mapped IPv6 prefix so one client always hashes the same. */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.toLowerCase().startsWith('::ffff:')
    ? trimmed.slice(7)
    : trimmed;
}

/**
 * Returns a copy of `value` that is safe to store: sensitive keys are
 * replaced, long strings and big arrays are cut down, and nesting is capped.
 */
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return truncate(value, MAX_STRING_VALUE);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeMetadata(item, depth + 1));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      result[key] = SENSITIVE_KEY.test(key)
        ? REDACTED
        : sanitizeMetadata(item, depth + 1);
    }
    return result;
  }

  return null;
}

/**
 * Quotes a CSV cell. Cells that start with a formula character are prefixed
 * with an apostrophe so a spreadsheet will not run attacker-controlled text.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === 'object') {
    text = JSON.stringify(value);
  } else {
    text = String(value as string | number | boolean | bigint | symbol);
  }
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Records, searches, exports and expires audit logs.
 *
 * Encryption: IP address, user agent and metadata are encrypted with
 * AES-256-GCM using a key derived (HKDF) from `AUDIT_LOG_ENCRYPTION_KEY`.
 * Each value gets its own random IV and is bound to its field name, so a
 * ciphertext cannot be moved to another column undetected. A second derived
 * key produces the keyed IP hash used for search.
 */
@Injectable()
export class AuditLoggerService {
  private readonly logger = new Logger(AuditLoggerService.name);
  private readonly encryptionKey: Buffer;
  private readonly indexKey: Buffer;
  private readonly retentionDays: number;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(AuditLog)
    private readonly repository: Repository<AuditLog>,
  ) {
    const master = this.parseMasterKey(
      this.configService.get<string>('AUDIT_LOG_ENCRYPTION_KEY'),
    );
    this.encryptionKey = this.derive(master, 'stow-audit-encryption');
    this.indexKey = this.derive(master, 'stow-audit-ip-index');
    this.retentionDays = this.parseRetention(
      this.configService.get<string>('AUDIT_LOG_RETENTION_DAYS'),
    );
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  /** Stores one entry, encrypting its sensitive fields. */
  async record(input: AuditEntryInput): Promise<AuditLog> {
    const action = (input.action ?? '').trim();
    if (!action) {
      throw new Error('An audit entry needs an action');
    }

    const ip = input.ipAddress ? normalizeIp(input.ipAddress) : null;
    const userAgent = input.userAgent
      ? truncate(input.userAgent, MAX_USER_AGENT_LENGTH)
      : null;
    const metadata = this.serializeMetadata(input.metadata);

    const entry = this.repository.create({
      userId: input.userId ?? null,
      action: truncate(action, MAX_ACTION_LENGTH),
      method: input.method ? input.method.toUpperCase().slice(0, 10) : null,
      endpoint: input.endpoint
        ? truncate(input.endpoint, MAX_ENDPOINT_LENGTH)
        : null,
      statusCode: input.statusCode ?? null,
      durationMs:
        input.durationMs === null || input.durationMs === undefined
          ? null
          : Math.max(0, Math.round(input.durationMs)),
      ipHash: ip ? this.hashIp(ip) : null,
      ipAddressEnc: ip ? this.encrypt(ip, FIELD_IP) : null,
      userAgentEnc: userAgent
        ? this.encrypt(userAgent, FIELD_USER_AGENT)
        : null,
      metadataEnc: metadata ? this.encrypt(metadata, FIELD_METADATA) : null,
    });

    return this.repository.save(entry);
  }

  /**
   * Like `record`, but never throws: a failure to write an audit entry is
   * logged and must not break the request that triggered it.
   */
  async recordSafely(input: AuditEntryInput): Promise<void> {
    try {
      await this.record(input);
    } catch (error) {
      this.logger.error(
        `Failed to write audit log for "${input.action}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Searching
  // ---------------------------------------------------------------------------

  async search(
    filters: AuditFilters = {},
    page = 1,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<AuditSearchResult> {
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeLimit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(limit) || DEFAULT_PAGE_SIZE),
    );

    const [rows, total] = await this.repository.findAndCount({
      where: this.buildWhere(filters),
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });

    return {
      items: rows.map((row) => this.toView(row)),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  /**
   * Most-used endpoints in the window: request count, distinct users, error
   * count (status >= 400), average duration and last access.
   */
  async getAccessPatterns(
    filters: AuditFilters = {},
    top = 20,
  ): Promise<AccessPattern[]> {
    const query = this.repository
      .createQueryBuilder('log')
      .select('log.method', 'method')
      .addSelect('log.endpoint', 'endpoint')
      .addSelect('COUNT(*)', 'requests')
      .addSelect('COUNT(DISTINCT log.user_id)', 'uniqueUsers')
      .addSelect('COUNT(*) FILTER (WHERE log.status_code >= 400)', 'errors')
      .addSelect('COALESCE(AVG(log.duration_ms), 0)', 'averageDurationMs')
      .addSelect('MAX(log.created_at)', 'lastAccessedAt')
      .where('log.endpoint IS NOT NULL')
      .groupBy('log.method')
      .addGroupBy('log.endpoint')
      .orderBy('requests', 'DESC')
      .limit(Math.min(100, Math.max(1, Math.floor(top) || 20)));

    if (filters.userId) {
      query.andWhere('log.user_id = :userId', { userId: filters.userId });
    }
    if (filters.action) {
      query.andWhere('log.action ILIKE :action', {
        action: `%${escapeLike(filters.action)}%`,
      });
    }
    if (filters.endpoint) {
      query.andWhere('log.endpoint ILIKE :endpoint', {
        endpoint: `%${escapeLike(filters.endpoint)}%`,
      });
    }
    if (filters.method) {
      query.andWhere('log.method = :method', {
        method: filters.method.toUpperCase(),
      });
    }
    if (filters.statusCode !== undefined) {
      query.andWhere('log.status_code = :statusCode', {
        statusCode: filters.statusCode,
      });
    }
    if (filters.ip) {
      query.andWhere('log.ip_hash = :ipHash', {
        ipHash: this.hashIp(normalizeIp(filters.ip)),
      });
    }
    if (filters.from) {
      query.andWhere('log.created_at >= :from', { from: filters.from });
    }
    if (filters.to) {
      query.andWhere('log.created_at <= :to', { to: filters.to });
    }

    const rows = await query.getRawMany<{
      method: string | null;
      endpoint: string;
      requests: string;
      uniqueUsers: string;
      errors: string;
      averageDurationMs: string;
      lastAccessedAt: Date | string;
    }>();

    return rows.map((row) => ({
      method: row.method,
      endpoint: row.endpoint,
      requests: Number(row.requests),
      uniqueUsers: Number(row.uniqueUsers),
      errors: Number(row.errors),
      averageDurationMs: Math.round(Number(row.averageDurationMs)),
      lastAccessedAt: new Date(row.lastAccessedAt),
    }));
  }

  // ---------------------------------------------------------------------------
  // Exporting
  // ---------------------------------------------------------------------------

  /**
   * A CSV of every matching entry (newest first) with all fields decrypted,
   * capped at `MAX_EXPORT_ROWS`.
   */
  async exportCsv(filters: AuditFilters = {}): Promise<string> {
    const lines = [CSV_COLUMNS.join(',')];
    const where = this.buildWhere(filters);

    for (
      let offset = 0;
      offset < MAX_EXPORT_ROWS;
      offset += EXPORT_BATCH_SIZE
    ) {
      const rows = await this.repository.find({
        where,
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: offset,
        take: Math.min(EXPORT_BATCH_SIZE, MAX_EXPORT_ROWS - offset),
      });

      for (const row of rows) {
        const view = this.toView(row);
        lines.push(
          [
            view.id,
            view.createdAt,
            view.userId,
            view.action,
            view.method,
            view.endpoint,
            view.statusCode,
            view.durationMs,
            view.ipAddress,
            view.userAgent,
            view.metadata ? JSON.stringify(view.metadata) : '',
          ]
            .map(csvCell)
            .join(','),
        );
      }

      if (rows.length < EXPORT_BATCH_SIZE) break;
    }

    return `${lines.join('\r\n')}\r\n`;
  }

  // ---------------------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------------------

  getRetentionDays(): number {
    return this.retentionDays;
  }

  /** Deletes entries older than the retention window. Returns how many. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000);
    const result = await this.repository.delete({
      createdAt: LessThan(cutoff),
    });
    const deleted = result.affected ?? 0;
    if (deleted > 0) {
      this.logger.log(
        `Purged ${deleted} audit log entries older than ${this.retentionDays} days`,
      );
    }
    return deleted;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredOnSchedule(): Promise<void> {
    try {
      await this.purgeExpired();
    } catch (error) {
      this.logger.error(
        `Audit log retention purge failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private buildWhere(filters: AuditFilters): FindOptionsWhere<AuditLog> {
    const where: FindOptionsWhere<AuditLog> = {};

    if (filters.userId) where.userId = filters.userId;
    if (filters.method) where.method = filters.method.toUpperCase();
    if (filters.statusCode !== undefined) where.statusCode = filters.statusCode;
    if (filters.action) {
      where.action = ILike(`%${escapeLike(filters.action)}%`);
    }
    if (filters.endpoint) {
      where.endpoint = ILike(`%${escapeLike(filters.endpoint)}%`);
    }
    if (filters.ip) where.ipHash = this.hashIp(normalizeIp(filters.ip));

    if (filters.from && filters.to) {
      where.createdAt = Between(filters.from, filters.to);
    } else if (filters.from) {
      where.createdAt = MoreThanOrEqual(filters.from);
    } else if (filters.to) {
      where.createdAt = LessThanOrEqual(filters.to);
    }

    return where;
  }

  private toView(row: AuditLog): AuditEntryView {
    let decryptionFailed = false;
    const open = (value: string | null, field: string): string | null => {
      if (!value) return null;
      try {
        return this.decrypt(value, field);
      } catch {
        decryptionFailed = true;
        return null;
      }
    };

    const ipAddress = open(row.ipAddressEnc, FIELD_IP);
    const userAgent = open(row.userAgentEnc, FIELD_USER_AGENT);
    const metadataText = open(row.metadataEnc, FIELD_METADATA);

    let metadata: Record<string, unknown> | null = null;
    if (metadataText) {
      try {
        metadata = JSON.parse(metadataText) as Record<string, unknown>;
      } catch {
        decryptionFailed = true;
      }
    }

    return {
      id: row.id,
      createdAt: row.createdAt,
      userId: row.userId,
      action: row.action,
      method: row.method,
      endpoint: row.endpoint,
      statusCode: row.statusCode,
      durationMs: row.durationMs,
      ipAddress,
      userAgent,
      metadata,
      decryptionFailed,
    };
  }

  private serializeMetadata(
    metadata: Record<string, unknown> | null | undefined,
  ): string | null {
    if (!metadata || Object.keys(metadata).length === 0) return null;
    const json = JSON.stringify(sanitizeMetadata(metadata));
    return Buffer.byteLength(json) > MAX_METADATA_BYTES
      ? JSON.stringify({ truncated: true })
      : json;
  }

  private encrypt(plain: string, field: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(field));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      FORMAT_VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      body.toString('base64url'),
    ].join('.');
  }

  private decrypt(token: string, field: string): string {
    const [version, iv, tag, body] = token.split('.');
    if (version !== FORMAT_VERSION || !iv || !tag || body === undefined) {
      throw new Error('Unrecognised ciphertext format');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(field));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private hashIp(ip: string): string {
    return createHmac('sha256', this.indexKey).update(ip).digest('hex');
  }

  private derive(master: Buffer, info: string): Buffer {
    return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  }

  /** Accepts a 32-byte key as 64 hex characters or as base64. */
  private parseMasterKey(value: string | undefined): Buffer {
    if (!value) {
      throw new AuditConfigError(
        'AUDIT_LOG_ENCRYPTION_KEY is required: audit logs are always encrypted',
      );
    }
    const key = /^[0-9a-fA-F]{64}$/.test(value)
      ? Buffer.from(value, 'hex')
      : Buffer.from(value, 'base64');
    if (key.length !== 32) {
      throw new AuditConfigError(
        'AUDIT_LOG_ENCRYPTION_KEY must be 32 bytes, given as 64 hex characters or base64',
      );
    }
    return key;
  }

  private parseRetention(value: string | undefined): number {
    if (value === undefined || value === '') return DEFAULT_RETENTION_DAYS;
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1) {
      throw new AuditConfigError(
        'AUDIT_LOG_RETENTION_DAYS must be a whole number of days, 1 or more',
      );
    }
    return days;
  }
}
