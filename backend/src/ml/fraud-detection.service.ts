import { Injectable, Logger, NotFoundException } from '@nestjs/common';

/**
 * Savings-account fraud detection.
 *
 * A logistic-regression model scores every transaction against the
 * behaviour of its own account (typical amounts, active hours, cadence).
 * Scores above the review threshold are auto-flagged into a review queue;
 * reviewer verdicts become labels for retraining. Every score comes with a
 * per-feature explanation in plain language.
 *
 * The model can be trained here (`train` / `retrain`) or offline with
 * `src/ml/models/fraud-detector.py`, whose exported JSON is loaded with
 * `loadModel`. Both use the same features, so the two are interchangeable.
 */

export type TransactionType = 'deposit' | 'withdrawal' | 'transfer';

export interface TransactionInput {
  id: string;
  accountId: string;
  /** Transaction amount in whole currency units (must be >= 0). */
  amount: number;
  timestamp: Date | string;
  type: TransactionType;
  /** Account balance immediately before this transaction, when known. */
  balanceBefore?: number;
}

export interface LabeledTransaction extends TransactionInput {
  isFraud: boolean;
}

/** Order matters: it is the column order of the model's weight vector. */
export const FEATURE_NAMES = [
  'amount_deviation',
  'unusual_hour',
  'night_time',
  'burst_frequency',
  'withdrawal',
  'balance_drain',
  'new_account',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export interface FraudModel {
  version: number;
  feature_names: readonly string[];
  weights: number[];
  bias: number;
  /** Per-feature standardization applied before the weights. */
  mean: number[];
  std: number[];
  /** Probability at or above which a transaction is flagged for review. */
  threshold: number;
  trained_at: string | null;
  training_size: number;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export interface FeatureContribution {
  feature: FeatureName;
  value: number;
  /** The value relative to the training population (z-score). */
  standardized: number;
  /** Signed effect on the log-odds of fraud. */
  contribution: number;
}

export interface FraudExplanation {
  /** Human-readable reasons, most influential first. */
  reasons: string[];
  contributions: FeatureContribution[];
}

export interface TransactionRiskScore {
  transactionId: string;
  accountId: string;
  /** Fraud probability in [0, 1]. */
  probability: number;
  /** Risk score in [0, 100]. */
  riskScore: number;
  level: RiskLevel;
  flagged: boolean;
  explanation: FraudExplanation;
  modelVersion: number;
}

export interface AccountRiskScore {
  accountId: string;
  riskScore: number;
  level: RiskLevel;
  transactionsScored: number;
  flaggedTransactions: number;
  topReasons: string[];
}

export type ReviewStatus = 'pending' | 'confirmed_fraud' | 'dismissed';

export interface ReviewItem {
  transactionId: string;
  accountId: string;
  riskScore: number;
  reasons: string[];
  flaggedAt: Date;
  status: ReviewStatus;
}

export interface ModelMetrics {
  accuracy: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
  support: number;
}

export interface RetrainResult {
  previousVersion: number;
  version: number;
  trainingSize: number;
  before: ModelMetrics;
  after: ModelMetrics;
}

export interface TrainingOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
}

interface FeatureContext {
  amount: number;
  typicalAmount: number | null;
  hour: number;
  recentCount: number;
  drainRatio: number;
}

interface Featurized {
  values: number[];
  context: FeatureContext;
}

interface ScoredRecord {
  transaction: TransactionInput;
  features: Featurized;
  score: TransactionRiskScore;
  label?: boolean;
}

interface HistoryEntry {
  timestamp: number;
  amount: number;
  hour: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** History needed before an account's own baseline is trusted. */
const MIN_AMOUNT_HISTORY = 3;
const MIN_HOUR_HISTORY = 5;
/** Accounts younger than this are treated as new. */
const NEW_ACCOUNT_MS = 7 * DAY_MS;
/** Floor on the log-amount spread so very regular accounts don't explode. */
const MIN_LOG_STD = 0.25;
const MAX_AMOUNT_DEVIATION = 10;
/** Hours on either side of a transaction counted as "usual" activity. */
const HOUR_WINDOW = 2;
/** Recent history kept per account. */
const MAX_HISTORY = 500;
const MEDIUM_THRESHOLD = 0.4;
/** Minimum contribution (log-odds) for a feature to be cited as a reason. */
const REASON_MIN_CONTRIBUTION = 0.25;

/**
 * Hand-tuned prior used until the model is trained: big deviations in
 * amount, odd hours, bursts and balance drains all raise risk.
 */
export function defaultFraudModel(): FraudModel {
  return {
    version: 0,
    feature_names: FEATURE_NAMES,
    weights: [0.9, 1.5, 1.0, 1.2, 0.5, 1.5, 0.5],
    bias: -4,
    mean: FEATURE_NAMES.map(() => 0),
    std: FEATURE_NAMES.map(() => 1),
    threshold: 0.7,
    trained_at: null,
    training_size: 0,
  };
}

/**
 * Per-account behavioural history used to derive features. Kept separate
 * from the service so training can replay transactions without touching
 * live state.
 */
export class TransactionHistory {
  private readonly accounts = new Map<string, HistoryEntry[]>();
  private readonly firstSeen = new Map<string, number>();

  /** Features for `tx` relative to history *before* it. */
  featurize(tx: TransactionInput): Featurized {
    const ts = toMillis(tx.timestamp);
    const hour = new Date(ts).getUTCHours();
    const history = this.accounts.get(tx.accountId) ?? [];
    const amount = Math.max(0, tx.amount);
    const logAmount = Math.log1p(amount);

    // How far the amount is from this account's typical (log-scale) amount.
    let amountDeviation = 0;
    let typicalAmount: number | null = null;
    if (history.length >= MIN_AMOUNT_HISTORY) {
      const logs = history.map((h) => Math.log1p(h.amount));
      const mean = logs.reduce((s, v) => s + v, 0) / logs.length;
      const variance = logs.reduce((s, v) => s + (v - mean) ** 2, 0) / logs.length;
      const std = Math.max(Math.sqrt(variance), MIN_LOG_STD);
      amountDeviation = clamp((logAmount - mean) / std, -MAX_AMOUNT_DEVIATION, MAX_AMOUNT_DEVIATION);
      typicalAmount = Math.expm1(mean);
    }

    // Share of past activity outside a +/-2h window around this hour.
    let unusualHour = 0;
    if (history.length >= MIN_HOUR_HISTORY) {
      const near = history.filter((h) => hourDistance(h.hour, hour) <= HOUR_WINDOW).length;
      unusualHour = 1 - near / history.length;
    }

    const nightTime = hour < 5 ? 1 : 0;

    const recentCount = history.filter(
      (h) => h.timestamp <= ts && ts - h.timestamp <= HOUR_MS,
    ).length;
    const burstFrequency = Math.log1p(recentCount);

    const withdrawal = tx.type === 'withdrawal' ? 1 : 0;

    let drainRatio = 0;
    if (tx.type !== 'deposit' && tx.balanceBefore !== undefined && tx.balanceBefore > 0) {
      drainRatio = clamp(amount / tx.balanceBefore, 0, 1);
    }

    const first = this.firstSeen.get(tx.accountId);
    const newAccount = first === undefined || ts - first < NEW_ACCOUNT_MS ? 1 : 0;

    return {
      values: [
        amountDeviation,
        unusualHour,
        nightTime,
        burstFrequency,
        withdrawal,
        drainRatio,
        newAccount,
      ],
      context: { amount, typicalAmount, hour, recentCount, drainRatio },
    };
  }

  record(tx: TransactionInput): void {
    const ts = toMillis(tx.timestamp);
    const list = this.accounts.get(tx.accountId) ?? [];
    list.push({ timestamp: ts, amount: Math.max(0, tx.amount), hour: new Date(ts).getUTCHours() });
    if (list.length > MAX_HISTORY) list.shift();
    this.accounts.set(tx.accountId, list);
    const first = this.firstSeen.get(tx.accountId);
    if (first === undefined || ts < first) this.firstSeen.set(tx.accountId, ts);
  }
}

@Injectable()
export class FraudDetectionService {
  private readonly logger = new Logger(FraudDetectionService.name);

  private model: FraudModel = defaultFraudModel();
  private history = new TransactionHistory();
  private readonly records = new Map<string, ScoredRecord>();
  private readonly reviewQueue = new Map<string, ReviewItem>();
  /** Labeled examples from initial training, kept for retraining. */
  private trainingSet: { values: number[]; label: boolean }[] = [];

  // --- model management --------------------------------------------------

  getModel(): FraudModel {
    return {
      ...this.model,
      weights: [...this.model.weights],
      mean: [...this.model.mean],
      std: [...this.model.std],
    };
  }

  /** Load a model, e.g. one exported by `models/fraud-detector.py`. */
  loadModel(model: FraudModel): void {
    const n = FEATURE_NAMES.length;
    const namesMatch =
      model.feature_names.length === n &&
      model.feature_names.every((name, i) => name === FEATURE_NAMES[i]);
    if (
      !namesMatch ||
      model.weights.length !== n ||
      model.mean.length !== n ||
      model.std.length !== n
    ) {
      throw new Error(
        `Model features do not match the expected features: ${FEATURE_NAMES.join(', ')}`,
      );
    }
    if (!(model.threshold > 0 && model.threshold < 1)) {
      throw new Error('Model threshold must be between 0 and 1');
    }
    this.model = {
      ...model,
      std: model.std.map((s) => (s > 0 ? s : 1)),
    };
  }

  /**
   * Train a fresh model on labeled transactions. Transactions are replayed
   * in time order through an isolated history so each example sees only the
   * activity that preceded it.
   */
  train(examples: LabeledTransaction[], options: TrainingOptions = {}): ModelMetrics {
    const history = new TransactionHistory();
    const sorted = [...examples].sort(
      (a, b) => toMillis(a.timestamp) - toMillis(b.timestamp),
    );
    this.trainingSet = sorted.map((tx) => {
      const { values } = history.featurize(tx);
      history.record(tx);
      return { values, label: tx.isFraud };
    });

    this.model = fitLogisticRegression(
      this.trainingSet,
      this.model.version + 1,
      this.model.threshold,
      options,
    );
    this.logger.log(
      `Trained fraud model v${this.model.version} on ${this.trainingSet.length} examples`,
    );
    return evaluate(this.model, this.trainingSet);
  }

  /**
   * Retrain on the initial training data plus every reviewed or labeled
   * transaction. Returns metrics of the old and new model on the combined
   * labeled set, so callers can confirm the update helped.
   */
  retrain(options: TrainingOptions = {}): RetrainResult {
    const feedback = [...this.records.values()]
      .filter((r) => r.label !== undefined)
      .map((r) => ({ values: r.features.values, label: r.label! }));
    const data = [...this.trainingSet, ...feedback];
    if (!data.some((d) => d.label) || !data.some((d) => !d.label)) {
      throw new Error('Retraining needs both fraudulent and legitimate examples');
    }

    const previous = this.model;
    const before = evaluate(previous, data);
    this.model = fitLogisticRegression(data, previous.version + 1, previous.threshold, options);
    const after = evaluate(this.model, data);

    // Feedback is now part of the training set; keep it for future retrains.
    this.trainingSet = data;
    for (const record of this.records.values()) {
      record.label = undefined;
    }

    this.logger.log(
      `Retrained fraud model v${previous.version} -> v${this.model.version} ` +
        `(accuracy ${before.accuracy.toFixed(3)} -> ${after.accuracy.toFixed(3)})`,
    );
    return {
      previousVersion: previous.version,
      version: this.model.version,
      trainingSize: data.length,
      before,
      after,
    };
  }

  /** Metrics of the current model on labeled transactions (no state change). */
  evaluate(examples: LabeledTransaction[]): ModelMetrics {
    const history = new TransactionHistory();
    const sorted = [...examples].sort(
      (a, b) => toMillis(a.timestamp) - toMillis(b.timestamp),
    );
    const data = sorted.map((tx) => {
      const { values } = history.featurize(tx);
      history.record(tx);
      return { values, label: tx.isFraud };
    });
    return evaluate(this.model, data);
  }

  // --- scoring ---------------------------------------------------------------

  /**
   * Score a transaction against its account's history, record it, and
   * auto-flag it for review when the probability reaches the threshold.
   */
  scoreTransaction(tx: TransactionInput): TransactionRiskScore {
    const features = this.history.featurize(tx);
    this.history.record(tx);

    const { probability, contributions } = predict(this.model, features.values);
    const flagged = probability >= this.model.threshold;
    const score: TransactionRiskScore = {
      transactionId: tx.id,
      accountId: tx.accountId,
      probability,
      riskScore: Math.round(probability * 1000) / 10,
      level: this.levelFor(probability),
      flagged,
      explanation: explain(contributions, features.context),
      modelVersion: this.model.version,
    };
    this.records.set(tx.id, { transaction: tx, features, score });

    if (flagged && !this.reviewQueue.has(tx.id)) {
      this.reviewQueue.set(tx.id, {
        transactionId: tx.id,
        accountId: tx.accountId,
        riskScore: score.riskScore,
        reasons: score.explanation.reasons,
        flaggedAt: new Date(),
        status: 'pending',
      });
      this.logger.warn(
        `Transaction ${tx.id} flagged for review (risk ${score.riskScore})`,
      );
    }
    return score;
  }

  scoreTransactions(txs: TransactionInput[]): TransactionRiskScore[] {
    return [...txs]
      .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))
      .map((tx) => this.scoreTransaction(tx));
  }

  /**
   * Account-level risk: weighted towards the riskiest recent transaction,
   * with the average providing context. Any flagged recent transaction makes
   * the account high risk.
   */
  getAccountRisk(accountId: string, recent = 50): AccountRiskScore {
    const scores = [...this.records.values()]
      .filter((r) => r.transaction.accountId === accountId)
      .map((r) => r.score)
      .slice(-recent);
    if (scores.length === 0) {
      throw new NotFoundException(`No scored transactions for account ${accountId}`);
    }
    const max = Math.max(...scores.map((s) => s.probability));
    const mean = scores.reduce((s, v) => s + v.probability, 0) / scores.length;
    const probability = 0.8 * max + 0.2 * mean;
    const riskiest = scores.reduce((a, b) => (b.probability > a.probability ? b : a));
    const flaggedTransactions = scores.filter((s) => s.flagged).length;
    return {
      accountId,
      riskScore: Math.round(probability * 1000) / 10,
      level: flaggedTransactions > 0 ? 'high' : this.levelFor(probability),
      transactionsScored: scores.length,
      flaggedTransactions,
      topReasons: riskiest.explanation.reasons,
    };
  }

  // --- review workflow -------------------------------------------------------

  getReviewQueue(status: ReviewStatus = 'pending'): ReviewItem[] {
    return [...this.reviewQueue.values()]
      .filter((item) => item.status === status)
      .sort((a, b) => b.riskScore - a.riskScore);
  }

  /** Record a reviewer's verdict on a flagged transaction. */
  resolveReview(transactionId: string, isFraud: boolean): ReviewItem {
    const item = this.reviewQueue.get(transactionId);
    if (!item) {
      throw new NotFoundException(`Transaction ${transactionId} is not in the review queue`);
    }
    item.status = isFraud ? 'confirmed_fraud' : 'dismissed';
    this.labelTransaction(transactionId, isFraud);
    return item;
  }

  /**
   * Label any scored transaction (e.g. a fraud case reported later that was
   * never flagged) so the next `retrain` learns from it.
   */
  labelTransaction(transactionId: string, isFraud: boolean): void {
    const record = this.records.get(transactionId);
    if (!record) {
      throw new NotFoundException(`Transaction ${transactionId} has not been scored`);
    }
    record.label = isFraud;
  }

  /** Forget all live state (history, scores, queue); keeps the model. */
  reset(): void {
    this.history = new TransactionHistory();
    this.records.clear();
    this.reviewQueue.clear();
  }

  private levelFor(probability: number): RiskLevel {
    if (probability >= this.model.threshold) return 'high';
    if (probability >= MEDIUM_THRESHOLD) return 'medium';
    return 'low';
  }
}

// --- model math ---------------------------------------------------------------

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function predict(
  model: FraudModel,
  values: number[],
): { probability: number; contributions: FeatureContribution[] } {
  let z = model.bias;
  const contributions: FeatureContribution[] = values.map((value, i) => {
    const standardized = (value - model.mean[i]) / model.std[i];
    const contribution = model.weights[i] * standardized;
    z += contribution;
    return { feature: FEATURE_NAMES[i], value, standardized, contribution };
  });
  return { probability: sigmoid(z), contributions };
}

/**
 * Class-balanced, L2-regularized logistic regression fitted by full-batch
 * gradient descent on standardized features. Deterministic (zero init).
 */
function fitLogisticRegression(
  data: { values: number[]; label: boolean }[],
  version: number,
  threshold: number,
  options: TrainingOptions,
): FraudModel {
  const epochs = options.epochs ?? 2000;
  const lr = options.learningRate ?? 0.5;
  const l2 = options.l2 ?? 1e-3;
  const n = FEATURE_NAMES.length;
  const m = data.length;
  if (m === 0) throw new Error('Cannot train on an empty dataset');

  const mean = new Array<number>(n).fill(0);
  const std = new Array<number>(n).fill(0);
  for (const d of data) d.values.forEach((v, i) => (mean[i] += v / m));
  for (const d of data) d.values.forEach((v, i) => (std[i] += (v - mean[i]) ** 2 / m));
  for (let i = 0; i < n; i++) {
    std[i] = Math.sqrt(std[i]);
    if (std[i] < 1e-9) std[i] = 1;
  }
  const xs = data.map((d) => d.values.map((v, i) => (v - mean[i]) / std[i]));

  // Balance classes so rare fraud cases are not drowned out.
  const positives = data.filter((d) => d.label).length;
  const negatives = m - positives;
  const posWeight = positives > 0 ? m / (2 * positives) : 1;
  const negWeight = negatives > 0 ? m / (2 * negatives) : 1;

  const weights = new Array<number>(n).fill(0);
  let bias = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Array<number>(n).fill(0);
    let gradBias = 0;
    for (let j = 0; j < m; j++) {
      const x = xs[j];
      let z = bias;
      for (let i = 0; i < n; i++) z += weights[i] * x[i];
      const y = data[j].label ? 1 : 0;
      const w = data[j].label ? posWeight : negWeight;
      const err = (sigmoid(z) - y) * w;
      for (let i = 0; i < n; i++) grad[i] += err * x[i];
      gradBias += err;
    }
    for (let i = 0; i < n; i++) {
      weights[i] -= lr * (grad[i] / m + l2 * weights[i]);
    }
    bias -= lr * (gradBias / m);
  }

  return {
    version,
    feature_names: FEATURE_NAMES,
    weights,
    bias,
    mean,
    std,
    threshold,
    trained_at: new Date().toISOString(),
    training_size: m,
  };
}

function evaluate(
  model: FraudModel,
  data: { values: number[]; label: boolean }[],
): ModelMetrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const d of data) {
    const flagged = predict(model, d.values).probability >= model.threshold;
    if (flagged && d.label) tp++;
    else if (flagged && !d.label) fp++;
    else if (!flagged && d.label) fn++;
    else tn++;
  }
  const total = data.length || 1;
  return {
    accuracy: (tp + tn) / total,
    precision: tp + fp > 0 ? tp / (tp + fp) : 0,
    recall: tp + fn > 0 ? tp / (tp + fn) : 0,
    falsePositiveRate: fp + tn > 0 ? fp / (fp + tn) : 0,
    support: data.length,
  };
}

// --- explanations ---------------------------------------------------------------

function explain(contributions: FeatureContribution[], ctx: FeatureContext): FraudExplanation {
  const sorted = [...contributions].sort((a, b) => b.contribution - a.contribution);
  // Only cite signals that are actually elevated: a negative weight times a
  // below-average value also raises the score, but "the account is not new"
  // is not a reason anyone can act on.
  const reasons = sorted
    .filter((c) => c.standardized > 0 && c.contribution >= REASON_MIN_CONTRIBUTION)
    .map((c) => describe(c.feature, ctx))
    .filter((r): r is string => r !== null);
  return {
    reasons: reasons.length > 0 ? reasons : ['No unusual activity detected.'],
    contributions: sorted,
  };
}

function describe(feature: FeatureName, ctx: FeatureContext): string | null {
  const hour = `${String(ctx.hour).padStart(2, '0')}:00 UTC`;
  switch (feature) {
    case 'amount_deviation': {
      if (ctx.typicalAmount === null) return null;
      const typical = formatAmount(ctx.typicalAmount);
      if (ctx.typicalAmount > 0 && ctx.amount >= ctx.typicalAmount) {
        const ratio = ctx.amount / ctx.typicalAmount;
        return `Amount ${formatAmount(ctx.amount)} is ${ratio.toFixed(1)}x larger than this account's typical ${typical}.`;
      }
      return `Amount ${formatAmount(ctx.amount)} is unusual compared with this account's typical ${typical}.`;
    }
    case 'unusual_hour':
      return `Made around ${hour}, outside this account's usual activity hours.`;
    case 'night_time':
      return `Made during late-night hours (${hour}).`;
    case 'burst_frequency':
      if (ctx.recentCount === 0) return null;
      return `${ctx.recentCount} other transaction${ctx.recentCount === 1 ? '' : 's'} on this account in the previous hour.`;
    case 'withdrawal':
      return 'Funds are leaving the account (withdrawal).';
    case 'balance_drain':
      if (ctx.drainRatio === 0) return null;
      return `Moves ${Math.round(ctx.drainRatio * 100)}% of the account balance.`;
    case 'new_account':
      return 'The account is less than a week old.';
    default:
      return null;
  }
}

// --- helpers -----------------------------------------------------------------

function toMillis(ts: Date | string): number {
  const ms = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
  if (Number.isNaN(ms)) throw new Error(`Invalid transaction timestamp: ${String(ts)}`);
  return ms;
}

function hourDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function formatAmount(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
