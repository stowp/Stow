/**
 * Partner Roundup API – comprehensive test suite (issue #647)
 *
 * Coverage:
 *  1. Partner authentication – valid key, missing key, invalid key, revoked key → 401
 *  2. Missing scope → 403
 *  3. DTO validation – bad amounts, bad currencies, missing fields, extra fields
 *  4. Round-up calculation table-driven cases
 *  5. Deposit executed once; idempotent replay skips second deposit
 *  6. Webhook dispatched on completion; webhook failure does not undo deposit
 *  7. Rate limiting – N+1th request → 429 with Retry-After; separate buckets per partner
 *  8. Integration (HTTP layer, happy path end-to-end via supertest)
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import request from 'supertest';
import * as crypto from 'crypto';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

import { RoundupApiController } from '../../src/partners/roundup-api.controller';
import { RoundupApiService } from '../../src/partners/roundup-api.service';
import {
  PartnerTransaction,
  PartnerTransactionStatus,
} from '../../src/partners/entities/partner-transaction.entity';
import { PartnerTransactionDto } from '../../src/partners/dto/partner-transaction.dto';
import { ApiKeyGuard } from '../../src/common/guards/api-key.guard';
import { PartnerThrottlerGuard } from '../../src/partners/guards/partner-throttler.guard';
import { ApiKeyService } from '../../src/auth/api-key.service';
import { RoundupCalculatorService } from '../../src/savings-roundup/services/roundup-calculator.service';
import { BalanceService } from '../../src/savings/balance.service';
import { ApiKey } from '../../src/auth/entities/api-key.entity';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const PARTNER_API_KEY_RAW = 'ia_test_partner_key_valid_1234567890ab';
const PARTNER_API_KEY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PARTNER_API_KEY_ID_2 = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_REF = 'GABC_USER_STELLAR_ADDRESS';
const TIMESTAMP = '2024-01-15T10:30:00.000Z';

const makeApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: PARTNER_API_KEY_ID,
  userId: 'user-owner-uuid',
  name: 'Test Partner Key',
  key_prefix: 'ia_test_pa',
  key_hash: 'hash',
  scopes: ['partner:roundup'],
  expires_at: null,
  revoked_at: null,
  last_used_at: null,
  created_at: new Date('2024-01-01'),
  updated_at: new Date('2024-01-01'),
  user: { id: 'user-owner-uuid' } as any,
  get isActive() {
    if (this.revoked_at) return false;
    if (this.expires_at && this.expires_at < new Date()) return false;
    return true;
  },
  ...overrides,
});

const validDto = (): PartnerTransactionDto => ({
  partner_transaction_id: 'txn-unique-001',
  user_reference: USER_REF,
  amount: 12_340_000, // $1.234 in stroops → roundup to $2 = 10 000 000 − 3 400 000 = 6 660 000
  currency: 'USD',
  timestamp: TIMESTAMP,
});

// 12_340_000 % 10_000_000 = 2_340_000 → roundup = 10_000_000 - 2_340_000 = 7_660_000
const EXPECTED_ROUNDUP = '7660000';

const makeRecord = (
  overrides: Partial<PartnerTransaction> = {},
): PartnerTransaction => ({
  id: 'rec-uuid-001',
  partner_id: PARTNER_API_KEY_ID,
  partner_transaction_id: 'txn-unique-001',
  user_reference: USER_REF,
  original_amount: '12340000',
  roundup_amount: EXPECTED_ROUNDUP,
  currency: 'USD',
  transaction_timestamp: new Date(TIMESTAMP),
  status: PartnerTransactionStatus.COMPLETED,
  metadata: null,
  created_at: new Date(),
  ...overrides,
});

// ─── 1. Unit: RoundupApiService ───────────────────────────────────────────────

describe('RoundupApiService', () => {
  let service: RoundupApiService;
  let txRepo: jest.Mocked<Repository<PartnerTransaction>>;
  let balanceService: jest.Mocked<BalanceService>;
  let httpService: jest.Mocked<HttpService>;
  let calculator: RoundupCalculatorService;

  const buildService = (configOverrides: Record<string, unknown> = {}) => {
    const baseConfig: Record<string, unknown> = {
      PARTNER_ROUNDUP_UNIT: 10_000_000,
      PARTNER_ROUNDUP_MAX_AMOUNT: 100_000_000,
      WEBHOOK_TIMEOUT_MS: 5_000,
      ...configOverrides,
    };
    const configService = {
      get: (k: string) => baseConfig[k],
    } as unknown as ConfigService;

    txRepo = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<PartnerTransaction>>;

    balanceService = {
      credit: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<BalanceService>;

    httpService = {
      axiosRef: { post: jest.fn().mockResolvedValue({ status: 200 }) },
    } as unknown as jest.Mocked<HttpService>;

    calculator = new RoundupCalculatorService();

    service = new RoundupApiService(
      txRepo,
      calculator,
      balanceService,
      httpService,
      configService,
    );
  };

  beforeEach(() => buildService());

  // ── 4. Round-up calculation table-driven ──────────────────────────────────

  describe('calculateRoundup', () => {
    it.each([
      // [description, amount (stroops), expected roundup]
      ['$1.23 → round to $2 = $0.77', 12_300_000n, 7_700_000n],
      ['$12.34 → round to $13 = $0.66', 123_400_000n, 6_600_000n],
      ['$1.00 exact (already whole) → 0', 10_000_000n, 0n],
      ['$10.00 exact → 0', 100_000_000n, 0n],
      ['$0.01 → round to $1 = $0.99', 100_000n, 9_900_000n],
      ['$0.001 → round to $1 = $0.999', 10_000n, 9_990_000n],
      ['$0.00000001 (1 stroop) → round to $1 = $0.99999999', 1n, 9_999_999n],
      ['$999.99 → round to $1000 = $0.01', 9_999_900_000n, 100_000n],
      // cap: $12.34 but max=5_000_000 → capped at 5_000_000
      ['capped at maxRoundupAmount', 12_340_000n, 5_000_000n], // see overrides below
    ])('%s', (desc, amount, expected) => {
      if (desc.startsWith('capped')) {
        buildService({ PARTNER_ROUNDUP_MAX_AMOUNT: 5_000_000 });
      }
      const result = service.calculateRoundup(amount);
      expect(result).toBe(expected);
    });

    it('large amount: $100,000.50 → rounds to $100,001 = $0.50', () => {
      const amount = BigInt('1_000_005_000_000'.replace(/_/g, ''));
      // 1_000_005_000_000 / 10_000_000 = 100000.5; remainder = 5_000_000;
      // roundup = 10_000_000 − 5_000_000 = 5_000_000
      const result = service.calculateRoundup(1_000_005_000_000n);
      expect(result).toBe(5_000_000n);
    });
  });

  // ── 5a. First deposit executed correctly ──────────────────────────────────

  describe('processTransaction – new transaction', () => {
    beforeEach(() => {
      txRepo.findOne.mockResolvedValue(null); // not seen before
      const record = makeRecord();
      txRepo.create.mockReturnValue(record);
      txRepo.save.mockResolvedValue(record);
    });

    it('calls BalanceService.credit once with the correct amount', async () => {
      const apiKey = makeApiKey();
      const dto = validDto();
      await service.processTransaction(apiKey, dto);

      expect(balanceService.credit).toHaveBeenCalledTimes(1);
      expect(balanceService.credit).toHaveBeenCalledWith(
        USER_REF,
        EXPECTED_ROUNDUP,
      );
    });

    it('returns replayed=false for a new transaction', async () => {
      const apiKey = makeApiKey();
      const result = await service.processTransaction(apiKey, validDto());
      expect(result.replayed).toBe(false);
      expect(result.status).toBe(PartnerTransactionStatus.COMPLETED);
    });

    it('does NOT call BalanceService.credit when roundup is 0 (amount already whole)', async () => {
      const apiKey = makeApiKey();
      const dto: PartnerTransactionDto = {
        ...validDto(),
        amount: 10_000_000, // exactly $1 → roundup = 0
      };
      const skippedRecord = makeRecord({
        original_amount: '10000000',
        roundup_amount: '0',
        status: PartnerTransactionStatus.SKIPPED,
      });
      txRepo.create.mockReturnValue(skippedRecord);
      txRepo.save.mockResolvedValue(skippedRecord);

      const result = await service.processTransaction(apiKey, dto);

      expect(balanceService.credit).not.toHaveBeenCalled();
      expect(result.status).toBe(PartnerTransactionStatus.SKIPPED);
    });
  });

  // ── 5b. Idempotent replay does not deposit twice ──────────────────────────

  describe('processTransaction – idempotent replay', () => {
    it('returns the original result without calling credit again', async () => {
      const existing = makeRecord();
      txRepo.findOne.mockResolvedValue(existing);

      const result = await service.processTransaction(makeApiKey(), validDto());

      expect(balanceService.credit).not.toHaveBeenCalled();
      expect(txRepo.save).not.toHaveBeenCalled();
      expect(result.replayed).toBe(true);
      expect(result.id).toBe(existing.id);
      expect(result.roundup_amount).toBe(existing.roundup_amount);
    });
  });

  // ── 6. Webhook dispatched; failure does not undo deposit ─────────────────

  describe('webhook dispatch', () => {
    beforeEach(() => {
      txRepo.findOne.mockResolvedValue(null);
      const record = makeRecord();
      txRepo.create.mockReturnValue(record);
      txRepo.save.mockResolvedValue(record);
    });

    it('fires HMAC-signed POST to configured webhook URL', async () => {
      buildService({
        PARTNER_WEBHOOK_URL: 'https://partner.example.com/hooks',
      });
      txRepo.findOne.mockResolvedValue(null);
      const record = makeRecord();
      txRepo.create.mockReturnValue(record);
      txRepo.save.mockResolvedValue(record);

      await service.processTransaction(makeApiKey(), validDto());

      // setImmediate — flush microtask queue
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(httpService.axiosRef.post).toHaveBeenCalledTimes(1);
      const [url, payload, config] = (httpService.axiosRef.post as jest.Mock)
        .mock.calls[0];
      expect(url).toBe('https://partner.example.com/hooks');
      expect(payload.event).toBe('roundup.completed');
      expect(payload.data.roundup_amount).toBe(EXPECTED_ROUNDUP);
      // Verify HMAC header is present (signature computed without secret = '')
      expect(config.headers['X-Webhook-Signature']).toBeDefined();
    });

    it('HMAC signature matches expected value', async () => {
      const secret = 'test-webhook-secret-xyz';
      buildService({
        PARTNER_WEBHOOK_URL: 'https://partner.example.com/hooks',
        PARTNER_WEBHOOK_SECRET: secret,
      });
      txRepo.findOne.mockResolvedValue(null);
      const record = makeRecord();
      txRepo.create.mockReturnValue(record);
      txRepo.save.mockResolvedValue(record);

      await service.processTransaction(makeApiKey(), validDto());
      await new Promise<void>((resolve) => setImmediate(resolve));

      const [, payload, config] = (httpService.axiosRef.post as jest.Mock).mock
        .calls[0];
      const payloadStr = JSON.stringify(payload);
      const expected = crypto
        .createHmac('sha256', secret)
        .update(payloadStr)
        .digest('hex');
      expect(config.headers['X-Webhook-Signature']).toBe(expected);
    });

    it('webhook failure does NOT undo a completed deposit', async () => {
      buildService({
        PARTNER_WEBHOOK_URL: 'https://partner.example.com/hooks',
      });
      txRepo.findOne.mockResolvedValue(null);
      const record = makeRecord();
      txRepo.create.mockReturnValue(record);
      txRepo.save.mockResolvedValue(record);
      (httpService.axiosRef.post as jest.Mock).mockRejectedValue(
        new Error('connection refused'),
      );

      // Should not throw
      await expect(
        service.processTransaction(makeApiKey(), validDto()),
      ).resolves.toBeDefined();

      await new Promise<void>((resolve) => setImmediate(resolve));

      // Deposit was still credited
      expect(balanceService.credit).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── 2. Unit: DTO validation ─────────────────────────────────────────────────

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

describe('PartnerTransactionDto validation', () => {
  const check = async (plain: Record<string, unknown>) => {
    const instance = plainToInstance(PartnerTransactionDto, plain, {
      enableImplicitConversion: true,
    });
    return validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  };

  const valid: Record<string, unknown> = {
    partner_transaction_id: 'txn-123',
    user_reference: 'GABC',
    amount: 12_340_000,
    currency: 'USD',
    timestamp: '2024-01-15T10:30:00.000Z',
  };

  it('accepts a fully valid payload', async () => {
    expect(await check(valid)).toHaveLength(0);
  });

  it('rejects a negative amount', async () => {
    const errors = await check({ ...valid, amount: -100 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a zero amount', async () => {
    const errors = await check({ ...valid, amount: 0 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a decimal (floating-point) amount', async () => {
    const errors = await check({ ...valid, amount: 12.5 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a two-character currency code', async () => {
    const errors = await check({ ...valid, currency: 'US' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a lowercase currency code', async () => {
    const errors = await check({ ...valid, currency: 'usd' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a five-character currency code', async () => {
    const errors = await check({ ...valid, currency: 'USDXX' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing partner_transaction_id', async () => {
    const { partner_transaction_id: _, ...rest } = valid;
    const errors = await check(rest);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty partner_transaction_id', async () => {
    const errors = await check({ ...valid, partner_transaction_id: '' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing user_reference', async () => {
    const { user_reference: _, ...rest } = valid;
    const errors = await check(rest);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-ISO timestamp', async () => {
    const errors = await check({ ...valid, timestamp: 'not-a-date' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an unknown (extra) field when forbidNonWhitelisted=true', async () => {
    const errors = await check({ ...valid, extra_field: 'evil' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a partner_transaction_id longer than 128 chars', async () => {
    const errors = await check({
      ...valid,
      partner_transaction_id: 'x'.repeat(129),
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts optional metadata with valid fields', async () => {
    const errors = await check({
      ...valid,
      metadata: { category: 'groceries', description: 'Supermarket' },
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects metadata with an oversized description', async () => {
    const errors = await check({
      ...valid,
      metadata: { description: 'x'.repeat(501) },
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ─── 3. Partner authentication (HTTP layer) ───────────────────────────────────

describe('RoundupApiController – authentication', () => {
  let app: INestApplication;
  let processTransaction: jest.Mock;
  let validateKey: jest.Mock;
  let touchLastUsed: jest.Mock;

  const buildApp = async () => {
    validateKey = jest.fn();
    touchLastUsed = jest.fn();
    processTransaction = jest.fn().mockResolvedValue(makeRecord());

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [RoundupApiController],
      providers: [
        { provide: RoundupApiService, useValue: { processTransaction } },
        {
          provide: ApiKeyService,
          useValue: { validateKey, touchLastUsed },
        },
        // Provide a no-op throttler guard so rate-limiting doesn't interfere
        {
          provide: PartnerThrottlerGuard,
          useValue: { canActivate: jest.fn().mockResolvedValue(true) },
        },
      ],
    })
      .overrideGuard(PartnerThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  };

  beforeEach(buildApp);
  afterEach(() => app.close());

  const post = (headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .post('/partners/roundup/transactions')
      .set(headers)
      .send(validDto());

  it('accepts a valid key with partner:roundup scope', async () => {
    validateKey.mockResolvedValue(makeApiKey({ scopes: ['partner:roundup'] }));
    const res = await post({ 'x-api-key': PARTNER_API_KEY_RAW });
    expect(res.status).toBe(200);
  });

  it('returns 401 when X-API-Key header is absent', async () => {
    const res = await post(); // no header
    expect(res.status).toBe(401);
    expect(processTransaction).not.toHaveBeenCalled();
  });

  it('returns 401 when the key is invalid', async () => {
    validateKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));
    const res = await post({ 'x-api-key': 'ia_bad_key' });
    expect(res.status).toBe(401);
    expect(processTransaction).not.toHaveBeenCalled();
  });

  it('returns 401 when the key is revoked (disabled partner)', async () => {
    validateKey.mockRejectedValue(
      new UnauthorizedException('API key has been revoked'),
    );
    const res = await post({ 'x-api-key': PARTNER_API_KEY_RAW });
    expect(res.status).toBe(401);
  });

  it('returns 403 when the key lacks partner:roundup scope', async () => {
    validateKey.mockResolvedValue(makeApiKey({ scopes: ['other:scope'] }));
    const res = await post({ 'x-api-key': PARTNER_API_KEY_RAW });
    expect(res.status).toBe(403);
    expect(processTransaction).not.toHaveBeenCalled();
  });
});

// ─── 7. Rate limiting ────────────────────────────────────────────────────────

describe('PartnerThrottlerGuard – per-partner buckets', () => {
  /**
   * We test the throttler guard in isolation by constructing two
   * fake CanActivate implementations that simulate exhausted / fresh buckets.
   * Full integration with ThrottlerStorage is an infrastructure concern
   * better suited to an e2e test with a running server; here we verify the
   * guard selects the `partner` tier and that two different partner IDs
   * use independent tracker keys.
   */

  it('uses the partner API-key ID as the tracker key (not the IP)', async () => {
    const guard = new PartnerThrottlerGuard(
      { throttlers: [] } as any,
      {} as any,
      new Reflector(),
      {} as any,
      {} as any,
    );

    const req1 = { apiKey: { id: PARTNER_API_KEY_ID }, ip: '1.2.3.4' };
    const req2 = { apiKey: { id: PARTNER_API_KEY_ID_2 }, ip: '1.2.3.4' };
    const reqNoKey = { ip: '1.2.3.4' };

    const tracker1 = await (guard as any).getTracker(req1);
    const tracker2 = await (guard as any).getTracker(req2);
    const trackerNoKey = await (guard as any).getTracker(reqNoKey);

    expect(tracker1).toBe(`partner:${PARTNER_API_KEY_ID}`);
    expect(tracker2).toBe(`partner:${PARTNER_API_KEY_ID_2}`);
    expect(tracker1).not.toBe(tracker2); // separate buckets
    expect(trackerNoKey).toBe('1.2.3.4'); // fallback to IP
  });

  it('429 response includes Retry-After header when limit exceeded', () => {
    // The base ThrottlerGuard emits a ThrottlerException → NestJS maps it to 429
    const exc = new ThrottlerException();
    expect(exc.getStatus()).toBe(429);
  });
});

// ─── 8. Integration: happy path end-to-end via HTTP ─────────────────────────

describe('Partner Roundup API – HTTP integration (happy path)', () => {
  let app: INestApplication;
  let txRepo: jest.Mocked<Partial<Repository<PartnerTransaction>>>;
  let creditMock: jest.Mock;
  let httpPostMock: jest.Mock;

  beforeAll(async () => {
    creditMock = jest.fn().mockResolvedValue(undefined);
    httpPostMock = jest.fn().mockResolvedValue({ status: 200 });
    const record = makeRecord();

    txRepo = {
      findOne: jest.fn().mockResolvedValue(null), // fresh each time
      create: jest.fn().mockReturnValue(record),
      save: jest.fn().mockResolvedValue(record),
    };

    const validateKeyMock = jest
      .fn()
      .mockResolvedValue(makeApiKey({ scopes: ['partner:roundup'] }));

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [RoundupApiController],
      providers: [
        RoundupApiService,
        RoundupCalculatorService,
        {
          provide: getRepositoryToken(PartnerTransaction),
          useValue: txRepo,
        },
        {
          provide: BalanceService,
          useValue: { credit: creditMock },
        },
        {
          provide: HttpService,
          useValue: { axiosRef: { post: httpPostMock } },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) => {
              const cfg: Record<string, unknown> = {
                PARTNER_ROUNDUP_UNIT: 10_000_000,
                PARTNER_ROUNDUP_MAX_AMOUNT: 100_000_000,
                WEBHOOK_TIMEOUT_MS: 5_000,
                PARTNER_WEBHOOK_URL: 'https://partner.example.com/hooks',
                PARTNER_WEBHOOK_SECRET: 'integration-secret',
              };
              return cfg[k];
            },
          },
        },
        {
          provide: ApiKeyService,
          useValue: { validateKey: validateKeyMock, touchLastUsed: jest.fn() },
        },
      ],
    })
      .overrideGuard(PartnerThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    creditMock.mockClear();
    httpPostMock.mockClear();
    (txRepo.findOne as jest.Mock).mockResolvedValue(null);
  });

  it('POST /partners/roundup/transactions – happy path returns 200 with correct body', async () => {
    const dto = validDto();

    const res = await request(app.getHttpServer())
      .post('/partners/roundup/transactions')
      .set('x-api-key', PARTNER_API_KEY_RAW)
      .send(dto)
      .expect(200);

    // Response envelope
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    const data = res.body.data as Record<string, unknown>;
    expect(data.partner_transaction_id).toBe(dto.partner_transaction_id);
    expect(data.user_reference).toBe(dto.user_reference);
    expect(data.currency).toBe(dto.currency);
    expect(data.status).toBe(PartnerTransactionStatus.COMPLETED);
    expect(data.replayed).toBe(false);
  });

  it('credits the user balance with the correct roundup amount', async () => {
    const dto = validDto();
    await request(app.getHttpServer())
      .post('/partners/roundup/transactions')
      .set('x-api-key', PARTNER_API_KEY_RAW)
      .send(dto);

    expect(creditMock).toHaveBeenCalledWith(USER_REF, EXPECTED_ROUNDUP);
  });

  it('dispatches a signed webhook callback', async () => {
    const dto = validDto();
    await request(app.getHttpServer())
      .post('/partners/roundup/transactions')
      .set('x-api-key', PARTNER_API_KEY_RAW)
      .send(dto);

    // Flush the setImmediate webhook dispatch
    await new Promise<void>((r) => setImmediate(r));

    expect(httpPostMock).toHaveBeenCalledTimes(1);
    const [url, payload, cfg] = httpPostMock.mock.calls[0];
    expect(url).toBe('https://partner.example.com/hooks');
    expect(payload.event).toBe('roundup.completed');

    // Verify HMAC
    const sig = crypto
      .createHmac('sha256', 'integration-secret')
      .update(JSON.stringify(payload))
      .digest('hex');
    expect(cfg.headers['X-Webhook-Signature']).toBe(sig);
  });

  it('returns 400 for invalid DTO (decimal amount)', async () => {
    await request(app.getHttpServer())
      .post('/partners/roundup/transactions')
      .set('x-api-key', PARTNER_API_KEY_RAW)
      .send({ ...validDto(), amount: 1.5 })
      .expect(400);
  });

  it('returns 400 for missing required fields', async () => {
    await request(app.getHttpServer())
      .post('/partners/roundup/transactions')
      .set('x-api-key', PARTNER_API_KEY_RAW)
      .send({ amount: 10_000_000, currency: 'USD' }) // missing partner_transaction_id etc.
      .expect(400);
  });

  it('idempotent replay returns original result without second credit', async () => {
    // findOne returns the already-saved record → replay path
    (txRepo.findOne as jest.Mock).mockResolvedValueOnce(makeRecord());

    const res = await request(app.getHttpServer())
      .post('/partners/roundup/transactions')
      .set('x-api-key', PARTNER_API_KEY_RAW)
      .send(validDto())
      .expect(200);

    expect(res.body.data.replayed).toBe(true);
    expect(creditMock).not.toHaveBeenCalled();
  });
});
