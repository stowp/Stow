import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

/**
 * Savings projection model driven by each user's own deposit behaviour.
 *
 * Deposits are bucketed into weekly totals and a recency-weighted linear
 * trend is fitted to them (weighted least squares, weights halving every
 * `half_life_weeks`). Forecasts use a damped trend so a recent burst does
 * not extrapolate forever, and the weighted residual spread gives the
 * confidence interval. Users with little history are shrunk toward a
 * population prior, so a brand new saver gets sensible numbers instead of
 * noise.
 *
 * Per-user fits are refreshed on every new deposit (`addDeposit`). The
 * population prior and half-life can be trained here (`trainPopulation`) or
 * offline with `src/ml/models/deposit-predictor.py`, whose exported JSON is
 * loaded with `loadModel`. Both implement the same maths.
 */

export interface DepositRecord {
  /** Deposit amount in whole currency units (must be > 0). */
  amount: number;
  timestamp: Date | string;
}

export interface PredictorPrior {
  /** Typical weekly deposit total. */
  level: number;
  /** Typical week-over-week change in the weekly total. */
  trend: number;
  /** Typical spread of weekly totals around the trend. */
  sigma: number;
  /** Weeks of personal history that weigh as much as the prior. 0 = off. */
  strength: number;
}

export interface DepositPredictorModel {
  version: number;
  half_life_weeks: number;
  /** Per-week trend damping factor in (0, 1]. */
  damping: number;
  prior: PredictorPrior;
  trained_at: string | null;
  /** Users the population prior was trained on. */
  training_size: number;
}

export interface DepositBehavior {
  depositCount: number;
  totalDeposited: number;
  averageDeposit: number;
  depositsPerWeek: number;
  /** Share of observed weeks with at least one deposit, 0-1. */
  activeWeekRatio: number;
  /** Most common deposit weekday (UTC), or null with no deposits. */
  preferredWeekday: string | null;
  lastDepositAt: string | null;
}

export interface UserFitSummary {
  userId: string;
  weeksObserved: number;
  /** Effective sample size of the history under the recency weights. */
  effectiveWeeks: number;
  /** Expected deposits next week. */
  level: number;
  trend: number;
  sigma: number;
  /** Weight given to the user's own history vs. the prior, 0-1. */
  personalWeight: number;
  behavior: DepositBehavior;
  /** Bumped every time the fit is refreshed. */
  revision: number;
  asOf: string;
  modelVersion: number;
}

export interface WeeklyForecast {
  week: number;
  weekStart: string;
  expected: number;
  lower: number;
  upper: number;
}

export interface SavingsPrediction {
  userId: string;
  horizonWeeks: number;
  confidence: number;
  /** Total expected deposits over the horizon. */
  expectedDeposits: number;
  lowerDeposits: number;
  upperDeposits: number;
  /** `currentBalance` plus the deposit forecast. */
  projectedBalance: { expected: number; lower: number; upper: number };
  weekly: WeeklyForecast[];
  behavior: DepositBehavior;
  revision: number;
  modelVersion: number;
  generatedAt: string;
}

export interface PredictionOptions {
  horizonWeeks?: number;
  confidence?: number;
  currentBalance?: number;
}

export interface GoalRecommendationRequest {
  /** Goal amount. When omitted, a target matching the user's capacity is suggested. */
  targetAmount?: number;
  /** Amount already saved toward the goal. */
  currentSaved?: number;
  /** Goal deadline. Takes precedence over `horizonWeeks`. */
  deadline?: Date | string;
  horizonWeeks?: number;
  confidence?: number;
}

export interface GoalRecommendation {
  userId: string;
  horizonWeeks: number;
  confidence: number;
  /** Weekly amount the user is expected to deposit. */
  expectedWeeklyCapacity: number;
  /** Weekly amount the user deposits with `confidence` probability. */
  conservativeWeeklyCapacity: number;
  targetAmount: number | null;
  /** Weekly deposit needed to reach the target in time. */
  requiredWeeklyDeposit: number | null;
  /** Probability (0-1) of reaching the target in time at current behaviour. */
  probabilityOfSuccess: number | null;
  feasible: boolean | null;
  /** Goal amount the user reaches with `confidence` probability. */
  recommendedTarget: number;
  recommendedWeeklyDeposit: number;
  /** Weeks needed to reach the target at the expected pace, if within 10 years. */
  weeksToTarget: number | null;
  message: string;
}

export interface BacktestResult {
  holdoutWeeks: number;
  actual: number;
  expected: number;
  lower: number;
  upper: number;
  withinInterval: boolean;
  /** Share of holdout weeks whose actual total fell inside the weekly interval. */
  weeklyCoverage: number;
}

interface RawFit {
  level: number;
  trend: number;
  /** null when there is too little data to estimate the spread. */
  variance: number | null;
  weeks: number;
  /** Effective sample size under the recency weights, (Σw)² / Σw². */
  effectiveWeeks: number;
}

interface UserState {
  deposits: { amount: number; time: number }[];
  asOf: number;
  fit: UserFitSummary;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Weeks are aligned to Monday 00:00 UTC (the epoch was a Thursday). */
const WEEK_OFFSET_MS = 4 * 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_HORIZON_WEEKS = 520;
const DEFAULT_HORIZON_WEEKS = 12;
const DEFAULT_CONFIDENCE = 0.9;
const Z_SCORES: Record<string, number> = {
  '0.5': 0.6745,
  '0.8': 1.2816,
  '0.9': 1.6449,
  '0.95': 1.96,
  '0.99': 2.5758,
};
export const SUPPORTED_CONFIDENCE_LEVELS = Object.keys(Z_SCORES).map(Number);
/** Minimum history before the population trainer scores one-step forecasts. */
const MIN_BACKTEST_WEEKS = 4;
const HALF_LIFE_GRID = [2, 4, 8, 13, 26, 52];

export function defaultDepositPredictorModel(): DepositPredictorModel {
  return {
    version: 0,
    half_life_weeks: 8,
    damping: 0.95,
    prior: { level: 0, trend: 0, sigma: 0, strength: 0 },
    trained_at: null,
    training_size: 0,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toTime(value: Date | string): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new BadRequestException(`Invalid timestamp: ${String(value)}`);
  }
  return time;
}

export function weekIndex(time: number): number {
  return Math.floor((time - WEEK_OFFSET_MS) / WEEK_MS);
}

function weekStart(index: number): Date {
  return new Date(index * WEEK_MS + WEEK_OFFSET_MS);
}

export function zScore(confidence: number): number {
  const z = Z_SCORES[String(confidence)];
  if (z === undefined) {
    throw new BadRequestException(
      `confidence must be one of ${SUPPORTED_CONFIDENCE_LEVELS.join(', ')}`,
    );
  }
  return z;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Weekly deposit totals from the first deposit's week through `asOf`'s week. */
export function weeklyTotals(
  deposits: { amount: number; time: number }[],
  asOf: number,
): number[] {
  if (deposits.length === 0) return [];
  const first = Math.min(...deposits.map((d) => d.time));
  const start = weekIndex(first);
  const end = Math.max(weekIndex(asOf), start);
  const totals = new Array<number>(end - start + 1).fill(0);
  for (const d of deposits) {
    const i = weekIndex(d.time) - start;
    if (i >= 0 && i < totals.length) totals[i] += d.amount;
  }
  return totals;
}

/** Recency-weighted least-squares trend; `level` is the fitted value at the latest week. */
export function fitTrend(series: number[], halfLifeWeeks: number): RawFit {
  const n = series.length;
  if (n === 0) return { level: 0, trend: 0, variance: null, weeks: 0, effectiveWeeks: 0 };
  if (n === 1) return { level: series[0], trend: 0, variance: null, weeks: 1, effectiveWeeks: 1 };

  let sw = 0;
  let sww = 0;
  let swx = 0;
  let swy = 0;
  const w: number[] = [];
  const x: number[] = [];
  for (let i = 0; i < n; i++) {
    x.push(i - (n - 1));
    w.push(Math.pow(0.5, (n - 1 - i) / halfLifeWeeks));
    sw += w[i];
    sww += w[i] * w[i];
    swx += w[i] * x[i];
    swy += w[i] * series[i];
  }
  const xm = swx / sw;
  const ym = swy / sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += w[i] * (x[i] - xm) ** 2;
    sxy += w[i] * (x[i] - xm) * (series[i] - ym);
  }
  const trend = sxx > 0 ? sxy / sxx : 0;
  const level = ym - trend * xm;

  let sse = 0;
  for (let i = 0; i < n; i++) {
    sse += w[i] * (series[i] - (level + trend * x[i])) ** 2;
  }
  const effectiveWeeks = (sw * sw) / sww;
  // Small-sample correction for the two fitted parameters.
  const variance = effectiveWeeks > 2 ? (sse / sw) * (effectiveWeeks / (effectiveWeeks - 2)) : null;
  return { level, trend, variance, weeks: n, effectiveWeeks };
}

/** Blend a personal fit with the population prior. */
export function shrink(raw: RawFit, prior: PredictorPrior): RawFit & { weight: number; sigma: number } {
  const weight = prior.strength > 0 ? raw.weeks / (raw.weeks + prior.strength) : 1;
  const level = weight * raw.level + (1 - weight) * prior.level;
  const trend = weight * raw.trend + (1 - weight) * prior.trend;
  const priorVariance = prior.sigma ** 2;
  let variance: number;
  if (raw.variance === null) {
    // Too little history to measure spread: lean on the prior, or assume
    // weekly totals vary by about half their level.
    variance = prior.strength > 0 && prior.sigma > 0 ? priorVariance : (0.5 * Math.abs(level) + 1) ** 2;
  } else {
    variance = weight * raw.variance + (1 - weight) * priorVariance;
  }
  return { ...raw, level, trend, variance, weight, sigma: Math.sqrt(variance) };
}

/**
 * Forecast standard deviations: a single week is `σ·√(1 + 1/n)` and the
 * cumulative total over `h` weeks is `σ·√(h + h²/n)`, where `n` is the
 * effective sample size — residual noise plus uncertainty in the fitted level.
 */
export function forecastSpread(sigma: number, effectiveWeeks: number, horizon: number) {
  const n = Math.max(effectiveWeeks, 1);
  return {
    weekly: sigma * Math.sqrt(1 + 1 / n),
    cumulative: sigma * Math.sqrt(horizon + (horizon * horizon) / n),
  };
}

/** Expected weekly totals for the next `horizon` weeks under a damped trend. */
export function forecastWeeks(level: number, trend: number, damping: number, horizon: number): number[] {
  const out: number[] = [];
  let cumulativeDamping = 0;
  for (let h = 1; h <= horizon; h++) {
    cumulativeDamping += Math.pow(damping, h);
    out.push(Math.max(0, level + trend * cumulativeDamping));
  }
  return out;
}

function behaviorOf(deposits: { amount: number; time: number }[], weeks: number[]): DepositBehavior {
  if (deposits.length === 0) {
    return {
      depositCount: 0,
      totalDeposited: 0,
      averageDeposit: 0,
      depositsPerWeek: 0,
      activeWeekRatio: 0,
      preferredWeekday: null,
      lastDepositAt: null,
    };
  }
  const total = deposits.reduce((sum, d) => sum + d.amount, 0);
  const dayCounts = new Array<number>(7).fill(0);
  for (const d of deposits) dayCounts[new Date(d.time).getUTCDay()]++;
  const preferred = dayCounts.indexOf(Math.max(...dayCounts));
  const last = Math.max(...deposits.map((d) => d.time));
  return {
    depositCount: deposits.length,
    totalDeposited: round2(total),
    averageDeposit: round2(total / deposits.length),
    depositsPerWeek: round2(deposits.length / Math.max(weeks.length, 1)),
    activeWeekRatio: round2(weeks.filter((t) => t > 0).length / Math.max(weeks.length, 1)),
    preferredWeekday: WEEKDAYS[preferred],
    lastDepositAt: new Date(last).toISOString(),
  };
}

@Injectable()
export class SavingsPredictionService {
  private readonly logger = new Logger(SavingsPredictionService.name);
  private model: DepositPredictorModel = defaultDepositPredictorModel();
  private readonly users = new Map<string, UserState>();

  getModel(): DepositPredictorModel {
    return { ...this.model, prior: { ...this.model.prior } };
  }

  /** Load a model exported by `deposit-predictor.py` (or `getModel`). Refits every user. */
  loadModel(model: DepositPredictorModel): void {
    if (
      !(model.half_life_weeks > 0) ||
      !(model.damping > 0 && model.damping <= 1) ||
      !model.prior ||
      !(model.prior.strength >= 0) ||
      !(model.prior.sigma >= 0)
    ) {
      throw new BadRequestException('Invalid deposit predictor model');
    }
    this.model = { ...model, prior: { ...model.prior } };
    for (const [userId, state] of this.users) this.refit(userId, state);
    this.logger.log(`Loaded deposit predictor model v${model.version}`);
  }

  /**
   * Train the population prior and pick the half-life with the lowest
   * one-step-ahead forecast error across all users' histories.
   */
  trainPopulation(histories: Record<string, DepositRecord[]>): DepositPredictorModel {
    const series: number[][] = [];
    for (const deposits of Object.values(histories)) {
      const parsed = this.parse(deposits);
      if (parsed.length === 0) continue;
      series.push(weeklyTotals(parsed, Math.max(...parsed.map((d) => d.time))));
    }
    if (series.length === 0) {
      throw new BadRequestException('No deposit history to train on');
    }

    let bestHalfLife = this.model.half_life_weeks;
    let bestError = Infinity;
    for (const halfLife of HALF_LIFE_GRID) {
      let error = 0;
      let count = 0;
      for (const s of series) {
        for (let t = MIN_BACKTEST_WEEKS; t < s.length; t++) {
          const fit = fitTrend(s.slice(0, t), halfLife);
          const predicted = forecastWeeks(fit.level, fit.trend, this.model.damping, 1)[0];
          error += (predicted - s[t]) ** 2;
          count++;
        }
      }
      if (count > 0 && error / count < bestError) {
        bestError = error / count;
        bestHalfLife = halfLife;
      }
    }

    const fits = series.map((s) => fitTrend(s, bestHalfLife));
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const variances = fits.map((f) => f.variance).filter((v): v is number => v !== null);
    this.loadModel({
      version: this.model.version + 1,
      half_life_weeks: bestHalfLife,
      damping: this.model.damping,
      prior: {
        level: mean(fits.map((f) => f.level)),
        trend: mean(fits.map((f) => f.trend)),
        sigma: variances.length > 0 ? Math.sqrt(mean(variances)) : 0,
        strength: 4,
      },
      trained_at: new Date().toISOString(),
      training_size: series.length,
    });
    return this.getModel();
  }

  /** Fit (or refit) a user's model on their full deposit history. */
  train(userId: string, deposits: DepositRecord[], asOf?: Date | string): UserFitSummary {
    const parsed = this.parse(deposits);
    if (parsed.length === 0) {
      throw new BadRequestException('At least one deposit is required to train');
    }
    const last = Math.max(...parsed.map((d) => d.time));
    const state: UserState = {
      deposits: parsed,
      asOf: asOf !== undefined ? Math.max(toTime(asOf), last) : last,
      fit: undefined as unknown as UserFitSummary,
    };
    const previous = this.users.get(userId);
    state.fit = this.buildFit(userId, state, (previous?.fit.revision ?? 0) + 1);
    this.users.set(userId, state);
    return state.fit;
  }

  /** Add a new deposit and refresh the user's predictions. */
  addDeposit(userId: string, deposit: DepositRecord): UserFitSummary {
    const state = this.users.get(userId);
    if (!state) return this.train(userId, [deposit]);
    const [parsed] = this.parse([deposit]);
    state.deposits.push(parsed);
    state.asOf = Math.max(state.asOf, parsed.time);
    this.refit(userId, state);
    return state.fit;
  }

  getFit(userId: string): UserFitSummary {
    return this.state(userId).fit;
  }

  predict(userId: string, options: PredictionOptions = {}): SavingsPrediction {
    const state = this.state(userId);
    const horizon = this.horizon(options.horizonWeeks);
    const confidence = options.confidence ?? DEFAULT_CONFIDENCE;
    const z = zScore(confidence);
    const balance = options.currentBalance ?? 0;
    const { fit } = state;

    const means = forecastWeeks(fit.level, fit.trend, this.model.damping, horizon);
    const sd = forecastSpread(fit.sigma, fit.effectiveWeeks, horizon);
    const firstWeek = weekIndex(state.asOf) + 1;
    const weekly = means.map((expected, i) => ({
      week: i + 1,
      weekStart: weekStart(firstWeek + i).toISOString(),
      expected: round2(expected),
      lower: round2(Math.max(0, expected - z * sd.weekly)),
      upper: round2(expected + z * sd.weekly),
    }));

    const expected = means.reduce((a, b) => a + b, 0);
    const spread = z * sd.cumulative;
    const lower = Math.max(0, expected - spread);
    const upper = expected + spread;

    return {
      userId,
      horizonWeeks: horizon,
      confidence,
      expectedDeposits: round2(expected),
      lowerDeposits: round2(lower),
      upperDeposits: round2(upper),
      projectedBalance: {
        expected: round2(balance + expected),
        lower: round2(balance + lower),
        upper: round2(balance + upper),
      },
      weekly,
      behavior: fit.behavior,
      revision: fit.revision,
      modelVersion: this.model.version,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Personalized goal advice sized to what the user actually deposits. */
  recommendGoal(userId: string, request: GoalRecommendationRequest = {}): GoalRecommendation {
    const state = this.state(userId);
    const confidence = request.confidence ?? DEFAULT_CONFIDENCE;
    const z = zScore(confidence);
    const saved = Math.max(0, request.currentSaved ?? 0);

    let horizon: number;
    if (request.deadline !== undefined) {
      const weeksLeft = Math.ceil((toTime(request.deadline) - state.asOf) / WEEK_MS);
      if (weeksLeft < 1) throw new BadRequestException('deadline must be in the future');
      horizon = this.horizon(weeksLeft);
    } else {
      horizon = this.horizon(request.horizonWeeks);
    }

    const prediction = this.predict(userId, { horizonWeeks: horizon, confidence });
    const expectedWeekly = prediction.expectedDeposits / horizon;
    const conservativeWeekly = prediction.lowerDeposits / horizon;
    const recommendedTarget = round2(saved + prediction.lowerDeposits);

    if (request.targetAmount === undefined) {
      return {
        userId,
        horizonWeeks: horizon,
        confidence,
        expectedWeeklyCapacity: round2(expectedWeekly),
        conservativeWeeklyCapacity: round2(conservativeWeekly),
        targetAmount: null,
        requiredWeeklyDeposit: null,
        probabilityOfSuccess: null,
        feasible: null,
        recommendedTarget,
        recommendedWeeklyDeposit: round2(conservativeWeekly),
        weeksToTarget: null,
        message: `At your current pace you can comfortably save ${recommendedTarget} in ${horizon} weeks.`,
      };
    }

    if (!(request.targetAmount > 0)) {
      throw new BadRequestException('targetAmount must be positive');
    }
    const remaining = Math.max(0, request.targetAmount - saved);
    const required = remaining / horizon;
    const sd = forecastSpread(state.fit.sigma, state.fit.effectiveWeeks, horizon).cumulative;
    const probability =
      remaining === 0
        ? 1
        : sd > 0
          ? 1 - normalCdf((remaining - prediction.expectedDeposits) / sd)
          : prediction.expectedDeposits >= remaining
            ? 1
            : 0;
    const feasible = prediction.expectedDeposits >= remaining;
    const weeksToTarget = this.weeksToReach(state.fit, remaining);

    const message = feasible
      ? `You are on track: deposit about ${round2(required)} a week to reach ${request.targetAmount}.`
      : weeksToTarget !== null
        ? `This goal needs ${round2(required)} a week, above your usual ${round2(expectedWeekly)}. ` +
          `Consider ${recommendedTarget} by the deadline, or allow ${weeksToTarget} weeks.`
        : `This goal needs ${round2(required)} a week, above your usual ${round2(expectedWeekly)}. ` +
          `Consider a target of ${recommendedTarget}.`;

    return {
      userId,
      horizonWeeks: horizon,
      confidence,
      expectedWeeklyCapacity: round2(expectedWeekly),
      conservativeWeeklyCapacity: round2(conservativeWeekly),
      targetAmount: request.targetAmount,
      requiredWeeklyDeposit: round2(required),
      probabilityOfSuccess: round2(probability),
      feasible,
      recommendedTarget,
      recommendedWeeklyDeposit: round2(feasible ? required : expectedWeekly),
      weeksToTarget,
      message,
    };
  }

  /**
   * Fit on everything before the last `holdoutWeeks` weeks and check the
   * forecast against what actually happened.
   */
  backtest(deposits: DepositRecord[], holdoutWeeks: number, confidence = DEFAULT_CONFIDENCE): BacktestResult {
    const parsed = this.parse(deposits);
    const z = zScore(confidence);
    const series = weeklyTotals(parsed, Math.max(...parsed.map((d) => d.time)));
    if (holdoutWeeks < 1 || series.length <= holdoutWeeks) {
      throw new BadRequestException('Not enough history for this holdout');
    }
    const train = series.slice(0, series.length - holdoutWeeks);
    const actualWeeks = series.slice(series.length - holdoutWeeks);
    const fit = shrink(fitTrend(train, this.model.half_life_weeks), this.model.prior);
    const means = forecastWeeks(fit.level, fit.trend, this.model.damping, holdoutWeeks);

    const expected = means.reduce((a, b) => a + b, 0);
    const actual = actualWeeks.reduce((a, b) => a + b, 0);
    const sd = forecastSpread(fit.sigma, fit.effectiveWeeks, holdoutWeeks);
    const spread = z * sd.cumulative;
    const lower = Math.max(0, expected - spread);
    const upper = expected + spread;
    const inside = actualWeeks.filter(
      (a, i) => a >= Math.max(0, means[i] - z * sd.weekly) && a <= means[i] + z * sd.weekly,
    ).length;

    return {
      holdoutWeeks,
      actual: round2(actual),
      expected: round2(expected),
      lower: round2(lower),
      upper: round2(upper),
      withinInterval: actual >= lower && actual <= upper,
      weeklyCoverage: round2(inside / holdoutWeeks),
    };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private state(userId: string): UserState {
    const state = this.users.get(userId);
    if (!state) {
      throw new NotFoundException(`No deposit history for user ${userId}; train the model first`);
    }
    return state;
  }

  private horizon(weeks?: number): number {
    const horizon = weeks ?? DEFAULT_HORIZON_WEEKS;
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON_WEEKS) {
      throw new BadRequestException(`horizonWeeks must be an integer between 1 and ${MAX_HORIZON_WEEKS}`);
    }
    return horizon;
  }

  private parse(deposits: DepositRecord[]): { amount: number; time: number }[] {
    return deposits.map((d) => {
      if (!Number.isFinite(d.amount) || d.amount <= 0) {
        throw new BadRequestException('Deposit amounts must be positive numbers');
      }
      return { amount: d.amount, time: toTime(d.timestamp) };
    });
  }

  private refit(userId: string, state: UserState): void {
    state.fit = this.buildFit(userId, state, (state.fit?.revision ?? 0) + 1);
  }

  private buildFit(userId: string, state: UserState, revision: number): UserFitSummary {
    const series = weeklyTotals(state.deposits, state.asOf);
    const fit = shrink(fitTrend(series, this.model.half_life_weeks), this.model.prior);
    return {
      userId,
      weeksObserved: series.length,
      effectiveWeeks: round2(fit.effectiveWeeks),
      level: round2(fit.level),
      trend: round2(fit.trend),
      sigma: fit.sigma,
      personalWeight: round2(fit.weight),
      behavior: behaviorOf(state.deposits, series),
      revision,
      asOf: new Date(state.asOf).toISOString(),
      modelVersion: this.model.version,
    };
  }

  private weeksToReach(fit: UserFitSummary, remaining: number): number | null {
    if (remaining <= 0) return 0;
    const means = forecastWeeks(fit.level, fit.trend, this.model.damping, MAX_HORIZON_WEEKS);
    let total = 0;
    for (let i = 0; i < means.length; i++) {
      total += means[i];
      if (total >= remaining) return i + 1;
    }
    return null;
  }
}
