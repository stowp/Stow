import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { SavingsPredictionController } from '../../src/ml/savings-prediction.controller';
import {
  DepositRecord,
  SavingsPredictionService,
  defaultDepositPredictorModel,
} from '../../src/ml/savings-prediction.service';

// ---------------------------------------------------------------------------
// Deterministic synthetic data
// ---------------------------------------------------------------------------

/** Seeded PRNG (mulberry32) so every run sees the same data. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
/** Monday 2026-01-05 00:00 UTC. */
const BASE = Date.UTC(2026, 0, 5);

/** One deposit every Wednesday of about `mean` (± `noise`) for `weeks` weeks. */
function weeklySaver(seed: number, weeks: number, mean = 100, noise = 20): DepositRecord[] {
  const r = rng(seed);
  return Array.from({ length: weeks }, (_, w) => ({
    amount: Math.round((mean + (r() * 2 - 1) * noise) * 100) / 100,
    timestamp: new Date(BASE + w * WEEK + 2 * DAY + 10 * 60 * 60 * 1000).toISOString(),
  }));
}

describe('SavingsPredictionService', () => {
  let service: SavingsPredictionService;

  beforeEach(() => {
    service = new SavingsPredictionService();
  });

  describe('training', () => {
    it('trains on historical deposit patterns', () => {
      const fit = service.train('user-1', weeklySaver(1, 26));

      expect(fit.weeksObserved).toBe(26);
      expect(fit.revision).toBe(1);
      expect(fit.level).toBeGreaterThan(80);
      expect(fit.level).toBeLessThan(120);
      expect(Math.abs(fit.trend)).toBeLessThan(5);
      expect(fit.sigma).toBeGreaterThan(0);
      expect(fit.behavior.depositCount).toBe(26);
      expect(fit.behavior.depositsPerWeek).toBe(1);
      expect(fit.behavior.activeWeekRatio).toBe(1);
      expect(fit.behavior.preferredWeekday).toBe('Wednesday');
    });

    it('picks up a growing savings habit', () => {
      const deposits = Array.from({ length: 20 }, (_, w) => ({
        amount: 50 + 10 * w,
        timestamp: new Date(BASE + w * WEEK + DAY).toISOString(),
      }));
      const fit = service.train('grower', deposits);
      expect(fit.trend).toBeCloseTo(10, 0);
      expect(fit.level).toBeCloseTo(240, 0);
    });

    it('rejects empty or invalid history', () => {
      expect(() => service.train('u', [])).toThrow();
      expect(() => service.train('u', [{ amount: -5, timestamp: new Date(BASE).toISOString() }])).toThrow();
      expect(() => service.train('u', [{ amount: 5, timestamp: 'not-a-date' }])).toThrow();
    });

    it('learns a population prior that stabilises cold-start users', () => {
      const histories: Record<string, DepositRecord[]> = {};
      for (let i = 0; i < 10; i++) histories[`u${i}`] = weeklySaver(100 + i, 30);

      const model = service.trainPopulation(histories);
      expect(model.version).toBe(defaultDepositPredictorModel().version + 1);
      expect(model.training_size).toBe(10);
      expect(model.prior.strength).toBeGreaterThan(0);
      expect(model.prior.level).toBeGreaterThan(80);
      expect(model.prior.level).toBeLessThan(120);

      // A newcomer with one unusually large deposit is pulled toward the prior.
      const fit = service.train('newcomer', [{ amount: 1_000, timestamp: new Date(BASE).toISOString() }]);
      expect(fit.personalWeight).toBeLessThan(0.5);
      expect(fit.level).toBeLessThan(1_000);
      expect(fit.level).toBeGreaterThan(model.prior.level);
    });
  });

  describe('predictions', () => {
    it('returns consistent confidence intervals', () => {
      service.train('user-1', weeklySaver(2, 26));
      const p = service.predict('user-1', { horizonWeeks: 12, confidence: 0.9, currentBalance: 500 });

      expect(p.weekly).toHaveLength(12);
      expect(p.lowerDeposits).toBeLessThanOrEqual(p.expectedDeposits);
      expect(p.expectedDeposits).toBeLessThanOrEqual(p.upperDeposits);
      expect(p.expectedDeposits).toBeGreaterThan(12 * 80);
      expect(p.expectedDeposits).toBeLessThan(12 * 120);
      expect(p.projectedBalance.expected).toBeCloseTo(500 + p.expectedDeposits, 1);
      for (const week of p.weekly) {
        expect(week.lower).toBeLessThanOrEqual(week.expected);
        expect(week.expected).toBeLessThanOrEqual(week.upper);
        expect(week.lower).toBeGreaterThanOrEqual(0);
      }
      // Forecast weeks follow the last observed week.
      expect(Date.parse(p.weekly[0].weekStart)).toBe(BASE + 26 * WEEK);

      // Higher confidence means a wider interval.
      const wide = service.predict('user-1', { horizonWeeks: 12, confidence: 0.99 });
      expect(wide.upperDeposits - wide.lowerDeposits).toBeGreaterThan(p.upperDeposits - p.lowerDeposits);
    });

    it('actual deposits fall within the predicted interval', () => {
      let inside = 0;
      const runs = 20;
      for (let seed = 0; seed < runs; seed++) {
        const result = service.backtest(weeklySaver(500 + seed, 30), 4, 0.9);
        expect(result.lower).toBeLessThanOrEqual(result.upper);
        if (result.withinInterval) inside++;
      }
      // 90% intervals should cover the large majority of holdouts.
      expect(inside / runs).toBeGreaterThanOrEqual(0.6);
    });

    it('rejects unsupported options', () => {
      service.train('user-1', weeklySaver(3, 10));
      expect(() => service.predict('user-1', { confidence: 0.42 })).toThrow();
      expect(() => service.predict('user-1', { horizonWeeks: 0 })).toThrow();
      expect(() => service.predict('nobody')).toThrow();
    });
  });

  describe('updates', () => {
    it('updates the model as new deposits arrive', () => {
      const history = weeklySaver(4, 12);
      const first = service.train('user-1', history);
      const before = service.predict('user-1', { horizonWeeks: 4 });

      const updated = service.addDeposit('user-1', {
        amount: 600,
        timestamp: new Date(BASE + 12 * WEEK + DAY).toISOString(),
      });
      const after = service.predict('user-1', { horizonWeeks: 4 });

      expect(updated.revision).toBe(first.revision + 1);
      expect(updated.behavior.depositCount).toBe(13);
      expect(updated.weeksObserved).toBe(13);
      expect(after.revision).toBe(updated.revision);
      expect(after.expectedDeposits).toBeGreaterThan(before.expectedDeposits);
    });

    it('starts a model from the first deposit', () => {
      const fit = service.addDeposit('fresh', { amount: 75, timestamp: new Date(BASE).toISOString() });
      expect(fit.weeksObserved).toBe(1);
      expect(fit.level).toBe(75);
    });
  });

  describe('goal recommendations', () => {
    beforeEach(() => {
      service.train('user-1', weeklySaver(5, 26));
    });

    it('suggests a target the user can reach', () => {
      const rec = service.recommendGoal('user-1', { horizonWeeks: 12, currentSaved: 200 });
      const p = service.predict('user-1', { horizonWeeks: 12 });

      expect(rec.targetAmount).toBeNull();
      expect(rec.recommendedTarget).toBeCloseTo(200 + p.lowerDeposits, 1);
      expect(rec.recommendedTarget).toBeLessThanOrEqual(200 + p.expectedDeposits);
      expect(rec.recommendedWeeklyDeposit).toBeLessThanOrEqual(rec.expectedWeeklyCapacity);
    });

    it('marks an affordable goal as on track', () => {
      const rec = service.recommendGoal('user-1', { targetAmount: 600, horizonWeeks: 12 });
      expect(rec.feasible).toBe(true);
      expect(rec.probabilityOfSuccess).toBeGreaterThan(0.9);
      expect(rec.requiredWeeklyDeposit).toBe(50);
      expect(rec.requiredWeeklyDeposit!).toBeLessThan(rec.expectedWeeklyCapacity);
    });

    it('flags a goal beyond the user capacity and proposes alternatives', () => {
      const rec = service.recommendGoal('user-1', { targetAmount: 10_000, horizonWeeks: 12 });
      expect(rec.feasible).toBe(false);
      expect(rec.probabilityOfSuccess).toBeLessThan(0.05);
      expect(rec.recommendedTarget).toBeLessThan(10_000);
      expect(rec.weeksToTarget).toBeGreaterThan(12);
      expect(rec.weeksToTarget).toBeLessThan(200);
    });

    it('sizes the horizon from a deadline', () => {
      const fit = service.getFit('user-1');
      const deadline = new Date(Date.parse(fit.asOf) + 8 * WEEK).toISOString();
      const rec = service.recommendGoal('user-1', { targetAmount: 400, deadline });
      expect(rec.horizonWeeks).toBe(8);
    });
  });

  describe('performance', () => {
    it('trains and predicts on five years of daily deposits quickly', () => {
      const r = rng(9);
      const deposits = Array.from({ length: 5 * 365 }, (_, d) => ({
        amount: 10 + r() * 5,
        timestamp: new Date(BASE + d * DAY).toISOString(),
      }));
      const start = Date.now();
      service.train('heavy', deposits);
      for (let i = 0; i < 100; i++) service.predict('heavy', { horizonWeeks: 52 });
      expect(Date.now() - start).toBeLessThan(1_000);
    });
  });
});

describe('SavingsPredictionController (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SavingsPredictionController],
      providers: [SavingsPredictionService],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { id: 'api-user' };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 404 before any history is uploaded', async () => {
    await request(app.getHttpServer()).get('/ml/savings-predictions').expect(404);
  });

  it('trains, predicts, updates and recommends over HTTP', async () => {
    const server = app.getHttpServer();

    const trained = await request(server)
      .post('/ml/savings-predictions/history')
      .send({ deposits: weeklySaver(7, 20) })
      .expect(201);
    expect(trained.body.userId).toBe('api-user');
    expect(trained.body.weeksObserved).toBe(20);

    const started = Date.now();
    const predicted = await request(server)
      .get('/ml/savings-predictions')
      .query({ horizonWeeks: 8, confidence: 0.95, currentBalance: 100 })
      .expect(200);
    expect(Date.now() - started).toBeLessThan(500);
    expect(predicted.body.horizonWeeks).toBe(8);
    expect(predicted.body.confidence).toBe(0.95);
    expect(predicted.body.weekly).toHaveLength(8);
    expect(predicted.body.lowerDeposits).toBeLessThanOrEqual(predicted.body.expectedDeposits);
    expect(predicted.body.expectedDeposits).toBeLessThanOrEqual(predicted.body.upperDeposits);

    const updated = await request(server)
      .post('/ml/savings-predictions/deposits')
      .send({ amount: 120, timestamp: new Date(BASE + 20 * WEEK + DAY).toISOString() })
      .expect(201);
    expect(updated.body.revision).toBe(trained.body.revision + 1);

    const rec = await request(server)
      .post('/ml/savings-predictions/recommendations')
      .send({ targetAmount: 500, horizonWeeks: 10 })
      .expect(200);
    expect(rec.body.feasible).toBe(true);
    expect(typeof rec.body.message).toBe('string');
  });

  it('validates input', async () => {
    const server = app.getHttpServer();
    await request(server).post('/ml/savings-predictions/history').send({ deposits: [] }).expect(400);
    await request(server)
      .post('/ml/savings-predictions/deposits')
      .send({ amount: -1, timestamp: new Date(BASE).toISOString() })
      .expect(400);
    await request(server).get('/ml/savings-predictions').query({ confidence: 0.42 }).expect(400);
  });
});
