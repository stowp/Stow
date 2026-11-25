import {
  FEATURE_NAMES,
  FraudDetectionService,
  LabeledTransaction,
  defaultFraudModel,
} from '../../src/ml/fraud-detection.service';

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

const BASE = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function between(r: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * r();
}

interface SyntheticAccount {
  txs: LabeledTransaction[];
  balance: number;
}

/**
 * 30 days of ordinary activity: one transaction a day during business hours
 * (09:00-17:59 UTC), amounts 80-120, mostly deposits.
 */
function normalAccount(r: () => number, accountId: string, days = 30): SyntheticAccount {
  const txs: LabeledTransaction[] = [];
  let balance = 2_000;
  for (let day = 0; day < days; day++) {
    const ts = BASE + day * DAY + Math.floor(between(r, 9, 18)) * 60 * MINUTE + Math.floor(between(r, 0, 59)) * MINUTE;
    const amount = Math.round(between(r, 80, 120) * 100) / 100;
    const type = r() < 0.8 ? 'deposit' : 'withdrawal';
    txs.push({
      id: `${accountId}-d${day}`,
      accountId,
      amount,
      timestamp: new Date(ts),
      type,
      balanceBefore: balance,
      isFraud: false,
    });
    balance += type === 'deposit' ? amount : -amount;
  }
  return { txs, balance };
}

/** Known pattern: a very large withdrawal in the middle of the night. */
function largeNightWithdrawal(r: () => number, account: SyntheticAccount, accountId: string): LabeledTransaction {
  const ts = BASE + 31 * DAY + Math.floor(between(r, 1, 4)) * 60 * MINUTE;
  return {
    id: `${accountId}-fraud-night`,
    accountId,
    amount: Math.round(between(r, 4_000, 6_000)),
    timestamp: new Date(ts),
    type: 'withdrawal',
    balanceBefore: account.balance,
    isFraud: true,
  };
}

/**
 * New pattern: rapid-fire withdrawals of ordinary size during normal hours.
 * The first two look legitimate; from the third one on it is fraud.
 */
function withdrawalBurst(r: () => number, account: SyntheticAccount, accountId: string): LabeledTransaction[] {
  const start = BASE + 31 * DAY + 14 * 60 * MINUTE;
  let balance = account.balance;
  const txs: LabeledTransaction[] = [];
  for (let i = 0; i < 6; i++) {
    const amount = Math.round(between(r, 80, 120));
    txs.push({
      id: `${accountId}-burst-${i}`,
      accountId,
      amount,
      timestamp: new Date(start + i * 2 * MINUTE),
      type: 'withdrawal',
      balanceBefore: balance,
      isFraud: i >= 2,
    });
    balance -= amount;
  }
  return txs;
}

/** Accounts with ordinary history; every `fraudEvery`-th ends with a large night withdrawal. */
function nightFraudDataset(seed: number, accounts: number, fraudEvery = 2): LabeledTransaction[] {
  const r = rng(seed);
  const all: LabeledTransaction[] = [];
  for (let i = 0; i < accounts; i++) {
    const id = `s${seed}-a${i}`;
    const account = normalAccount(r, id);
    all.push(...account.txs);
    if (i % fraudEvery === 0) all.push(largeNightWithdrawal(r, account, id));
  }
  return all;
}

function burstDataset(seed: number, accounts: number): LabeledTransaction[] {
  const r = rng(seed);
  const all: LabeledTransaction[] = [];
  for (let i = 0; i < accounts; i++) {
    const id = `b${seed}-a${i}`;
    const account = normalAccount(r, id);
    all.push(...account.txs, ...withdrawalBurst(r, account, id));
  }
  return all;
}

/** Probability that a random fraud scores above a random legitimate transaction. */
function auc(scores: { score: number; fraud: boolean }[]): number {
  const pos = scores.filter((s) => s.fraud).map((s) => s.score);
  const neg = scores.filter((s) => !s.fraud).map((s) => s.score);
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FraudDetectionService (integration)', () => {
  let service: FraudDetectionService;

  beforeEach(() => {
    service = new FraudDetectionService();
  });

  it('flags an obvious attack with the untrained default model', () => {
    const r = rng(1);
    const account = normalAccount(r, 'acct-default');
    service.scoreTransactions(account.txs);
    const score = service.scoreTransaction(largeNightWithdrawal(r, account, 'acct-default'));

    expect(score.flagged).toBe(true);
    expect(score.modelVersion).toBe(defaultFraudModel().version);
  });

  describe('after training on known fraud patterns', () => {
    beforeEach(() => {
      service.train(nightFraudDataset(42, 30));
    });

    it('detects the known fraud pattern on unseen accounts', () => {
      const metrics = service.evaluate(nightFraudDataset(7, 20));

      expect(metrics.recall).toBeGreaterThanOrEqual(0.9);
      expect(metrics.precision).toBeGreaterThanOrEqual(0.8);
    });

    it('keeps the false positive rate acceptable', () => {
      const metrics = service.evaluate(nightFraudDataset(9, 20));

      expect(metrics.falsePositiveRate).toBeLessThanOrEqual(0.05);
    });

    it('produces risk scores that correlate with actual fraud', () => {
      const data = nightFraudDataset(11, 20);
      const scored = service
        .scoreTransactions(data)
        .map((s) => ({
          score: s.riskScore,
          fraud: data.find((d) => d.id === s.transactionId)!.isFraud,
        }));

      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const fraudMean = mean(scored.filter((s) => s.fraud).map((s) => s.score));
      const legitMean = mean(scored.filter((s) => !s.fraud).map((s) => s.score));

      expect(fraudMean).toBeGreaterThan(legitMean + 50);
      expect(auc(scored)).toBeGreaterThanOrEqual(0.95);
      for (const s of scored) {
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(100);
      }
    });

    it('auto-flags high-risk activity for review and scores the account', () => {
      const r = rng(21);
      const victim = normalAccount(r, 'victim');
      const bystander = normalAccount(r, 'bystander');
      service.scoreTransactions([...victim.txs, ...bystander.txs]);
      expect(service.getReviewQueue()).toHaveLength(0);

      const attack = largeNightWithdrawal(r, victim, 'victim');
      const score = service.scoreTransaction(attack);

      expect(score.flagged).toBe(true);
      expect(score.level).toBe('high');
      const queue = service.getReviewQueue();
      expect(queue.map((q) => q.transactionId)).toEqual([attack.id]);
      expect(queue[0].status).toBe('pending');

      const victimRisk = service.getAccountRisk('victim');
      const bystanderRisk = service.getAccountRisk('bystander');
      expect(victimRisk.flaggedTransactions).toBe(1);
      expect(victimRisk.level).toBe('high');
      expect(victimRisk.riskScore).toBeGreaterThan(bystanderRisk.riskScore);
      expect(bystanderRisk.flaggedTransactions).toBe(0);

      const resolved = service.resolveReview(attack.id, true);
      expect(resolved.status).toBe('confirmed_fraud');
      expect(service.getReviewQueue()).toHaveLength(0);
      expect(service.getReviewQueue('confirmed_fraud')).toHaveLength(1);
    });

    it('explains scores in human-readable terms', () => {
      const r = rng(31);
      const account = normalAccount(r, 'explain');
      service.scoreTransactions(account.txs);
      const score = service.scoreTransaction(largeNightWithdrawal(r, account, 'explain'));

      const { reasons, contributions } = score.explanation;
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons.some((reason) => /larger than this account's typical/.test(reason))).toBe(true);
      expect(reasons.some((reason) => /UTC/.test(reason))).toBe(true);
      for (const reason of reasons) {
        expect(reason).toMatch(/^[A-Z0-9].*\.$/);
        expect(reason).not.toMatch(/NaN|undefined|null|Infinity/);
        expect(reason.length).toBeLessThan(160);
      }
      // Contributions cover every feature, most influential first.
      expect(contributions.map((c) => c.feature).sort()).toEqual([...FEATURE_NAMES].sort());
      for (let i = 1; i < contributions.length; i++) {
        expect(contributions[i - 1].contribution).toBeGreaterThanOrEqual(contributions[i].contribution);
      }
    });

    it('explains ordinary activity as unremarkable', () => {
      const r = rng(41);
      const account = normalAccount(r, 'calm');
      const scores = service.scoreTransactions(account.txs);
      const last = scores[scores.length - 1];

      expect(last.flagged).toBe(false);
      expect(last.level).toBe('low');
    });

    it('improves on a new fraud pattern after retraining on reviewed cases', () => {
      const holdout = burstDataset(99, 10);
      const before = service.evaluate(holdout);

      // New fraud cases arrive: score them live, then record the verdicts.
      const reported = burstDataset(55, 10);
      service.scoreTransactions(reported);
      for (const tx of reported.filter((t) => t.id.includes('-burst-'))) {
        if (tx.isFraud && service.getReviewQueue().some((q) => q.transactionId === tx.id)) {
          service.resolveReview(tx.id, true);
        } else {
          service.labelTransaction(tx.id, tx.isFraud);
        }
      }

      const previousVersion = service.getModel().version;
      const result = service.retrain();
      const after = service.evaluate(holdout);

      expect(result.previousVersion).toBe(previousVersion);
      expect(result.version).toBe(previousVersion + 1);
      expect(result.after.accuracy).toBeGreaterThan(result.before.accuracy);
      expect(after.recall).toBeGreaterThan(before.recall);
      expect(after.recall).toBeGreaterThanOrEqual(0.75);
      expect(after.accuracy).toBeGreaterThan(before.accuracy);
      // The old pattern is still caught.
      expect(service.evaluate(nightFraudDataset(7, 20)).recall).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('model management', () => {
    it('round-trips a model through loadModel (e.g. one exported by the Python trainer)', () => {
      service.train(nightFraudDataset(42, 10));
      const exported = JSON.parse(JSON.stringify(service.getModel()));

      const other = new FraudDetectionService();
      other.loadModel(exported);

      const data = nightFraudDataset(5, 5);
      expect(other.evaluate(data)).toEqual(service.evaluate(data));
    });

    it('rejects models with mismatched features', () => {
      const bad = { ...defaultFraudModel(), feature_names: ['amount'], weights: [1] };
      expect(() => service.loadModel(bad)).toThrow('Model features do not match');
    });

    it('requires both classes to retrain', () => {
      expect(() => service.retrain()).toThrow('both fraudulent and legitimate');
    });
  });
});
