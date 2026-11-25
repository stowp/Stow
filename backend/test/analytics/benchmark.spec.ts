import {
  ExecutionContext,
  HttpStatus,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AnalyticsAggregationService } from '../../src/analytics/analytics-aggregation.service';
import { AnalyticsController } from '../../src/analytics/analytics.controller';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import {
  BenchmarkService,
  MIN_COHORT_SIZE,
} from '../../src/analytics/benchmark.service';
import {
  AgeBracket,
  BenchmarkDataDto,
  CohortScope,
  IncomeBracket,
  InsightSeverity,
} from '../../src/analytics/dto/benchmark-data.dto';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';

/** Monthly income of 5,000 → 60k/year → the 50k-100k bracket. */
const INCOME = 5_000;

/** Record `count` peers aged 30 with the given monthly savings amounts. */
function seedPeers(
  service: BenchmarkService,
  period: string,
  savedAmounts: number[],
  opts: { income?: number; age?: number; prefix?: string } = {},
) {
  savedAmounts.forEach((saved, i) =>
    service.recordSnapshot(`${opts.prefix ?? 'peer'}-${i}`, {
      period,
      income: opts.income ?? INCOME,
      saved,
      age: opts.age ?? 30,
    }),
  );
}

describe('BenchmarkService', () => {
  let service: BenchmarkService;

  beforeEach(() => {
    service = new BenchmarkService();
  });

  describe('percentile calculations', () => {
    it('ranks with the mid-rank method', () => {
      const population = [10, 20, 30, 40];
      expect(BenchmarkService.percentileRank(5, population)).toBe(0);
      expect(BenchmarkService.percentileRank(20, population)).toBe(37.5);
      expect(BenchmarkService.percentileRank(25, population)).toBe(50);
      expect(BenchmarkService.percentileRank(50, population)).toBe(100);
    });

    it('interpolates quantiles', () => {
      const values = [10, 20, 30, 40, 50];
      expect(BenchmarkService.quantile(values, 0.5)).toBe(30);
      expect(BenchmarkService.quantile(values, 0.25)).toBe(20);
      expect(BenchmarkService.quantile([10, 20], 0.5)).toBe(15);
    });

    it('computes the savings rate as a clamped percentage', () => {
      expect(BenchmarkService.savingsRate(500, 5_000)).toBe(10);
      expect(BenchmarkService.savingsRate(1, 3)).toBe(33.33);
      expect(BenchmarkService.savingsRate(9_000, 5_000)).toBe(100);
      expect(BenchmarkService.savingsRate(100, 0)).toBe(0);
    });

    it("places the user correctly in the cohort's distribution", () => {
      // Peers save 5%, 10%, 15%, 20%, 25% of income.
      seedPeers(service, '2026-10', [250, 500, 750, 1_000, 1_250]);
      service.recordSnapshot('me', { period: '2026-10', income: INCOME, saved: 900, age: 30 });

      const result = service.getBenchmark('me');

      // 3 peers below 18%, plus the user's own (tied) entry: (3 + 0.5) / 6.
      expect(result.savings_rate).toBe(18);
      expect(result.percentile).toBe(58.3);
      expect(result.cohort.size).toBe(6);
      expect(result.cohort.median_rate).toBe(16.5);
    });
  });

  describe('demographic grouping', () => {
    it('maps income and age into brackets', () => {
      expect(BenchmarkService.incomeBracket(1_000)).toBe(IncomeBracket.UNDER_25K);
      expect(BenchmarkService.incomeBracket(INCOME)).toBe(IncomeBracket.FROM_50K_TO_100K);
      expect(BenchmarkService.incomeBracket(20_000)).toBe(IncomeBracket.OVER_200K);
      expect(BenchmarkService.ageBracket(24)).toBe(AgeBracket.UNDER_25);
      expect(BenchmarkService.ageBracket(35)).toBe(AgeBracket.FROM_35_TO_44);
      expect(BenchmarkService.ageBracket(70)).toBe(AgeBracket.OVER_64);
    });

    it('compares only against users in the same income and age brackets', () => {
      seedPeers(service, '2026-10', [250, 250, 250, 250, 250]);
      // A large, high-saving group in another age bracket must not count.
      seedPeers(service, '2026-10', [2_000, 2_000, 2_000, 2_000, 2_000], {
        age: 50,
        prefix: 'older',
      });
      service.recordSnapshot('me', { period: '2026-10', income: INCOME, saved: 500, age: 31 });

      const result = service.getBenchmark('me');

      expect(result.cohort.scope).toBe(CohortScope.INCOME_AND_AGE);
      expect(result.cohort.income_bracket).toBe(IncomeBracket.FROM_50K_TO_100K);
      expect(result.cohort.age_bracket).toBe(AgeBracket.FROM_25_TO_34);
      expect(result.cohort.size).toBe(6);
      expect(result.percentile).toBeGreaterThan(90);
      // Across all users the same rate ranks much lower.
      expect(result.overall_percentile).toBeLessThan(result.percentile);
    });

    it('widens to income-only when the exact cohort is too small', () => {
      seedPeers(service, '2026-10', [250, 500, 750], { prefix: 'young' });
      seedPeers(service, '2026-10', [250, 500, 750], { age: 50, prefix: 'older' });
      service.recordSnapshot('me', { period: '2026-10', income: INCOME, saved: 500, age: 30 });

      const result = service.getBenchmark('me');

      expect(result.cohort.scope).toBe(CohortScope.INCOME);
      expect(result.cohort.age_bracket).toBeNull();
      expect(result.cohort.size).toBe(7);
    });
  });

  describe('insights', () => {
    it('suggests a concrete amount to reach the cohort median', () => {
      seedPeers(service, '2026-10', [1_000, 1_000, 1_000, 1_000, 1_000]);
      service.recordSnapshot('me', { period: '2026-10', income: INCOME, saved: 250, age: 30 });

      const { insights } = service.getBenchmark('me');
      const belowMedian = insights.find((i) => i.code === 'BELOW_MEDIAN');

      expect(belowMedian).toBeDefined();
      expect(belowMedian!.severity).toBe(InsightSeverity.ACTION);
      // Median is 20% → 1,000 of 5,000; the user saves 250 → 750 short.
      expect(belowMedian!.suggestion).toContain('750');
      for (const insight of insights) {
        expect(insight.message.length).toBeGreaterThan(0);
        if (insight.severity === InsightSeverity.ACTION) {
          expect(insight.suggestion).toBeTruthy();
        }
      }
    });

    it('recognises top performers', () => {
      seedPeers(service, '2026-10', [250, 250, 250, 250, 250]);
      service.recordSnapshot('me', { period: '2026-10', income: INCOME, saved: 1_500, age: 30 });

      const codes = service.getBenchmark('me').insights.map((i) => i.code);

      expect(codes).toContain('TOP_QUARTILE');
      expect(codes).toContain('MEETS_TARGET');
    });

    it('nudges users who saved nothing', () => {
      seedPeers(service, '2026-10', [250, 250, 250, 250, 250]);
      service.recordSnapshot('me', { period: '2026-10', income: INCOME, saved: 0, age: 30 });

      const codes = service.getBenchmark('me').insights.map((i) => i.code);
      expect(codes).toContain('NO_SAVINGS');
    });
  });

  describe('trends', () => {
    it('tracks performance across periods in order', () => {
      for (const period of ['2026-08', '2026-09', '2026-10']) {
        seedPeers(service, period, [500, 500, 500, 500, 500]);
      }
      service.recordSnapshot('me', { period: '2026-10', income: INCOME, saved: 1_000, age: 30 });
      service.recordSnapshot('me', { period: '2026-08', income: INCOME, saved: 250, age: 30 });
      service.recordSnapshot('me', { period: '2026-09', income: INCOME, saved: 500, age: 30 });

      const result = service.getBenchmark('me');

      expect(result.period).toBe('2026-10');
      expect(result.trend.map((t) => t.period)).toEqual(['2026-08', '2026-09', '2026-10']);
      expect(result.trend.map((t) => t.savings_rate)).toEqual([5, 10, 20]);
      expect(result.trend_direction).toBe('improving');
      expect(result.insights.map((i) => i.code)).toContain('TREND_IMPROVING');
    });

    it('flags a declining savings rate', () => {
      seedPeers(service, '2026-09', [500, 500, 500, 500, 500]);
      seedPeers(service, '2026-10', [500, 500, 500, 500, 500]);
      service.recordSnapshot('me', { period: '2026-09', income: INCOME, saved: 1_000, age: 30 });
      service.recordSnapshot('me', { period: '2026-10', income: INCOME, saved: 400, age: 30 });

      const result = service.getBenchmark('me');

      expect(result.trend_direction).toBe('declining');
      expect(result.insights.map((i) => i.code)).toContain('TREND_DECLINING');
    });

    it('benchmarks a specific past period without later data', () => {
      seedPeers(service, '2026-09', [500, 500, 500, 500, 500]);
      seedPeers(service, '2026-10', [500, 500, 500, 500, 500]);
      service.recordSnapshot('me', { period: '2026-09', income: INCOME, saved: 1_000, age: 30 });
      service.recordSnapshot('me', { period: '2026-10', income: INCOME, saved: 400, age: 30 });

      const result = service.getBenchmark('me', '2026-09');

      expect(result.savings_rate).toBe(20);
      expect(result.trend.map((t) => t.period)).toEqual(['2026-09']);
      expect(result.trend_direction).toBe('insufficient_data');
    });
  });

  describe('anonymization', () => {
    it('exposes no identifiers or raw demographics in the dataset', () => {
      seedPeers(service, '2026-10', [250, 500, 750, 1_000, 1_250], { prefix: 'user-secret' });

      const rows = service.getAnonymizedDataset('2026-10');

      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(
          ['age_bracket', 'income_bracket', 'period', 'savings_rate'].sort(),
        );
      }
      expect(JSON.stringify(rows)).not.toContain('user-secret');
    });

    it('never returns stats for a cohort below the anonymity threshold', () => {
      seedPeers(service, '2026-10', Array(MIN_COHORT_SIZE - 2).fill(500));
      service.recordSnapshot('me', { period: '2026-10', income: INCOME, saved: 500, age: 30 });

      expect(() => service.getBenchmark('me')).toThrow('Not enough peers');
    });

    it('does not leak peer identifiers in a benchmark', () => {
      seedPeers(service, '2026-10', [250, 500, 750, 1_000, 1_250], { prefix: 'user-secret' });
      service.recordSnapshot('me', { period: '2026-10', income: INCOME, saved: 500, age: 30 });

      const serialized = JSON.stringify(service.getBenchmark('me'));
      expect(serialized).not.toContain('user-secret');
      expect(serialized).not.toContain('"income"');
      expect(serialized).not.toContain('"age"');
    });
  });
});

describe('GET /analytics/benchmark (integration)', () => {
  let app: INestApplication;
  let benchmarkService: BenchmarkService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        BenchmarkService,
        { provide: AnalyticsService, useValue: {} },
        { provide: AnalyticsAggregationService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: req.headers['x-test-user'] ?? 'anonymous', stellar_address: 'G' };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    benchmarkService = moduleRef.get(BenchmarkService);
  });

  afterEach(async () => {
    await app.close();
  });

  it('records snapshots and returns a valid benchmark', async () => {
    seedPeers(benchmarkService, '2026-10', [250, 500, 750, 1_000, 1_250]);

    await request(app.getHttpServer())
      .post('/analytics/benchmark/snapshot')
      .set('x-test-user', 'user-1')
      .send({ period: '2026-10', income: INCOME, saved: 900, age: 30 })
      .expect(HttpStatus.CREATED);

    const res = await request(app.getHttpServer())
      .get('/analytics/benchmark')
      .set('x-test-user', 'user-1')
      .expect(HttpStatus.OK);

    const body = res.body as { success: boolean; data: BenchmarkDataDto };
    expect(body.success).toBe(true);
    expect(body.data.period).toBe('2026-10');
    expect(body.data.savings_rate).toBe(18);
    expect(body.data.percentile).toBeGreaterThanOrEqual(0);
    expect(body.data.percentile).toBeLessThanOrEqual(100);
    expect(body.data.cohort.size).toBeGreaterThanOrEqual(MIN_COHORT_SIZE);
    expect(Array.isArray(body.data.insights)).toBe(true);
    expect(body.data.trend).toHaveLength(1);
  });

  it('rejects invalid snapshots', async () => {
    await request(app.getHttpServer())
      .post('/analytics/benchmark/snapshot')
      .set('x-test-user', 'user-1')
      .send({ period: '2026-13', income: -1, saved: 10, age: 30 })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('returns 404 when the user has no data', async () => {
    await request(app.getHttpServer())
      .get('/analytics/benchmark')
      .set('x-test-user', 'nobody')
      .expect(HttpStatus.NOT_FOUND);
  });
});
