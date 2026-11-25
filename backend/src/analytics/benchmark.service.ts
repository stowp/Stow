import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import {
  AgeBracket,
  BenchmarkDataDto,
  BenchmarkInsightDto,
  BenchmarkTrendPointDto,
  CohortScope,
  CohortStatsDto,
  IncomeBracket,
  InsightSeverity,
  RecordBenchmarkSnapshotDto,
} from './dto/benchmark-data.dto';

/** Smallest cohort we will compare against (k-anonymity threshold). */
export const MIN_COHORT_SIZE = 5;

/** Savings-rate guideline (percent of income) used in insights. */
const TARGET_SAVINGS_RATE = 20;

/** Trend points returned per benchmark. */
const MAX_TREND_POINTS = 12;

/** A change in savings rate (percentage points) treated as a real move. */
const TREND_THRESHOLD = 1;

/**
 * One period of a user's savings, stored without any direct identifier:
 * the owner is a salted hash, and age/income are reduced to brackets for
 * every comparison. The raw income is kept only to phrase the user's own
 * suggestions in currency; it is never exposed to other users.
 */
interface StoredSnapshot {
  period: string;
  income_bracket: IncomeBracket;
  age_bracket: AgeBracket;
  savings_rate: number;
  income: number;
}

/** An anonymized row of the comparison dataset: no id, brackets only. */
export interface AnonymizedBenchmarkRecord {
  period: string;
  income_bracket: IncomeBracket;
  age_bracket: AgeBracket;
  savings_rate: number;
}

interface CohortSelection {
  scope: CohortScope;
  rates: number[];
}

/**
 * Savings performance benchmarking.
 *
 * Users record a savings snapshot per period (income, amount saved, age).
 * Their savings rate is ranked against peers in the same income and age
 * brackets, with anonymized cohort statistics, actionable insights and a
 * period-over-period trend.
 *
 * Anonymization:
 * - user ids are replaced by a salted SHA-256 pseudonym before storage;
 * - age and income are bucketed into brackets for grouping;
 * - only aggregates of cohorts with at least {@link MIN_COHORT_SIZE} members
 *   are ever returned — smaller cohorts widen to income-only, then to all
 *   users, and if even that is too small no benchmark is produced.
 */
@Injectable()
export class BenchmarkService {
  /** pseudonym -> period -> snapshot */
  private readonly snapshots = new Map<string, Map<string, StoredSnapshot>>();

  private readonly salt: string;

  constructor() {
    this.salt =
      process.env.BENCHMARK_ANONYMIZATION_SALT ?? randomBytes(16).toString('hex');
  }

  /** Record (or replace) a user's snapshot for a period. */
  recordSnapshot(userId: string, input: RecordBenchmarkSnapshotDto): void {
    const key = this.pseudonymize(userId);
    const periods = this.snapshots.get(key) ?? new Map<string, StoredSnapshot>();
    periods.set(input.period, {
      period: input.period,
      income_bracket: BenchmarkService.incomeBracket(input.income),
      age_bracket: BenchmarkService.ageBracket(input.age),
      savings_rate: BenchmarkService.savingsRate(input.saved, input.income),
      income: input.income,
    });
    this.snapshots.set(key, periods);
  }

  /**
   * Benchmark a user's savings for `period` (default: their latest period).
   *
   * @throws NotFoundException if the user has no snapshot for the period, or
   * there are not enough users to compare against anonymously.
   */
  getBenchmark(userId: string, period?: string): BenchmarkDataDto {
    const periods = this.snapshots.get(this.pseudonymize(userId));
    if (!periods || periods.size === 0) {
      throw new NotFoundException('No savings data recorded for this user');
    }

    const sortedPeriods = [...periods.keys()].sort();
    const targetPeriod = period ?? sortedPeriods[sortedPeriods.length - 1];
    const own = periods.get(targetPeriod);
    if (!own) {
      throw new NotFoundException(`No savings data recorded for ${targetPeriod}`);
    }

    const cohort = this.selectCohort(own);
    if (!cohort) {
      throw new NotFoundException(
        'Not enough peers to produce an anonymous benchmark yet',
      );
    }

    const allRates = this.ratesFor(targetPeriod, () => true);
    const percentile = BenchmarkService.percentileRank(own.savings_rate, cohort.rates);
    const stats = this.cohortStats(own, cohort);

    const trend = sortedPeriods
      .filter((p) => p <= targetPeriod)
      .slice(-MAX_TREND_POINTS)
      .map((p) => this.trendPoint(periods.get(p)!))
      .filter((point): point is BenchmarkTrendPointDto => point !== null);
    const trendDirection = BenchmarkService.trendDirection(trend);

    return {
      period: targetPeriod,
      savings_rate: own.savings_rate,
      percentile,
      overall_percentile: BenchmarkService.percentileRank(own.savings_rate, allRates),
      cohort: stats,
      insights: this.buildInsights(own, percentile, stats, trend, trendDirection),
      trend,
      trend_direction: trendDirection,
    };
  }

  /**
   * The anonymized comparison dataset for a period: brackets and rates only,
   * with no identifier, sorted so row order reveals nothing about users.
   */
  getAnonymizedDataset(period: string): AnonymizedBenchmarkRecord[] {
    const rows: AnonymizedBenchmarkRecord[] = [];
    for (const periods of this.snapshots.values()) {
      const s = periods.get(period);
      if (s) {
        rows.push({
          period: s.period,
          income_bracket: s.income_bracket,
          age_bracket: s.age_bracket,
          savings_rate: s.savings_rate,
        });
      }
    }
    return rows.sort(
      (a, b) =>
        a.income_bracket.localeCompare(b.income_bracket) ||
        a.age_bracket.localeCompare(b.age_bracket) ||
        a.savings_rate - b.savings_rate,
    );
  }

  // --- grouping ------------------------------------------------------------

  static incomeBracket(income: number): IncomeBracket {
    // Snapshots are monthly; brackets are defined on annual income.
    const annual = income * 12;
    if (annual < 25_000) return IncomeBracket.UNDER_25K;
    if (annual < 50_000) return IncomeBracket.FROM_25K_TO_50K;
    if (annual < 100_000) return IncomeBracket.FROM_50K_TO_100K;
    if (annual < 200_000) return IncomeBracket.FROM_100K_TO_200K;
    return IncomeBracket.OVER_200K;
  }

  static ageBracket(age: number): AgeBracket {
    if (age < 25) return AgeBracket.UNDER_25;
    if (age < 35) return AgeBracket.FROM_25_TO_34;
    if (age < 45) return AgeBracket.FROM_35_TO_44;
    if (age < 55) return AgeBracket.FROM_45_TO_54;
    if (age < 65) return AgeBracket.FROM_55_TO_64;
    return AgeBracket.OVER_64;
  }

  // --- statistics ----------------------------------------------------------

  /** Saved as a percentage of income, clamped to [0, 100], 2 decimals. */
  static savingsRate(saved: number, income: number): number {
    if (income <= 0) return 0;
    const rate = (saved / income) * 100;
    return BenchmarkService.round(Math.min(100, Math.max(0, rate)), 2);
  }

  /**
   * Mid-rank percentile: the share of the cohort strictly below `value`,
   * plus half of those tied with it, scaled to 0-100 (1 decimal).
   */
  static percentileRank(value: number, population: number[]): number {
    if (population.length === 0) return 0;
    let below = 0;
    let equal = 0;
    for (const v of population) {
      if (v < value) below++;
      else if (v === value) equal++;
    }
    return BenchmarkService.round(((below + equal / 2) / population.length) * 100, 1);
  }

  /** Linear-interpolated quantile (`q` in [0, 1]) of `values`. */
  static quantile(values: number[], q: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const value = sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    return BenchmarkService.round(value, 2);
  }

  private static round(value: number, decimals: number): number {
    const f = 10 ** decimals;
    return Math.round(value * f) / f;
  }

  // --- internals -----------------------------------------------------------

  private pseudonymize(userId: string): string {
    return createHash('sha256').update(`${this.salt}:${userId}`).digest('hex');
  }

  private ratesFor(period: string, match: (s: StoredSnapshot) => boolean): number[] {
    const rates: number[] = [];
    for (const periods of this.snapshots.values()) {
      const s = periods.get(period);
      if (s && match(s)) rates.push(s.savings_rate);
    }
    return rates;
  }

  /** Narrowest cohort that still meets the anonymity threshold. */
  private selectCohort(own: StoredSnapshot): CohortSelection | null {
    const candidates: [CohortScope, (s: StoredSnapshot) => boolean][] = [
      [
        CohortScope.INCOME_AND_AGE,
        (s) => s.income_bracket === own.income_bracket && s.age_bracket === own.age_bracket,
      ],
      [CohortScope.INCOME, (s) => s.income_bracket === own.income_bracket],
      [CohortScope.ALL, () => true],
    ];
    for (const [scope, match] of candidates) {
      const rates = this.ratesFor(own.period, match);
      if (rates.length >= MIN_COHORT_SIZE) {
        return { scope, rates };
      }
    }
    return null;
  }

  private cohortStats(own: StoredSnapshot, cohort: CohortSelection): CohortStatsDto {
    const mean =
      cohort.rates.reduce((sum, r) => sum + r, 0) / cohort.rates.length;
    return {
      scope: cohort.scope,
      income_bracket: cohort.scope === CohortScope.ALL ? null : own.income_bracket,
      age_bracket: cohort.scope === CohortScope.INCOME_AND_AGE ? own.age_bracket : null,
      size: cohort.rates.length,
      mean_rate: BenchmarkService.round(mean, 2),
      median_rate: BenchmarkService.quantile(cohort.rates, 0.5),
      p25_rate: BenchmarkService.quantile(cohort.rates, 0.25),
      p75_rate: BenchmarkService.quantile(cohort.rates, 0.75),
    };
  }

  private trendPoint(snapshot: StoredSnapshot): BenchmarkTrendPointDto | null {
    const cohort = this.selectCohort(snapshot);
    if (!cohort) return null;
    return {
      period: snapshot.period,
      savings_rate: snapshot.savings_rate,
      percentile: BenchmarkService.percentileRank(snapshot.savings_rate, cohort.rates),
      cohort_median_rate: BenchmarkService.quantile(cohort.rates, 0.5),
    };
  }

  private static trendDirection(
    trend: BenchmarkTrendPointDto[],
  ): BenchmarkDataDto['trend_direction'] {
    if (trend.length < 2) return 'insufficient_data';
    const delta =
      trend[trend.length - 1].savings_rate - trend[trend.length - 2].savings_rate;
    if (delta > TREND_THRESHOLD) return 'improving';
    if (delta < -TREND_THRESHOLD) return 'declining';
    return 'stable';
  }

  /** Amount to save per period to lift the savings rate to `targetRate`. */
  private static gapAmount(own: StoredSnapshot, targetRate: number): number {
    const gap = Math.max(0, targetRate - own.savings_rate);
    return Math.ceil((gap / 100) * own.income);
  }

  private buildInsights(
    own: StoredSnapshot,
    percentile: number,
    stats: CohortStatsDto,
    trend: BenchmarkTrendPointDto[],
    direction: BenchmarkDataDto['trend_direction'],
  ): BenchmarkInsightDto[] {
    const insights: BenchmarkInsightDto[] = [];
    const peers = this.describeCohort(stats);

    if (own.savings_rate === 0) {
      const starter = Math.ceil(own.income * 0.05);
      insights.push({
        code: 'NO_SAVINGS',
        severity: InsightSeverity.ACTION,
        message: 'You did not save anything this period.',
        suggestion: `Start with a recurring deposit of ${starter} (5% of income) each period.`,
      });
    }

    if (percentile >= 75) {
      insights.push({
        code: 'TOP_QUARTILE',
        severity: InsightSeverity.POSITIVE,
        message: `You save more than ${Math.floor(percentile)}% of ${peers}.`,
      });
    } else if (own.savings_rate < stats.median_rate) {
      const amount = BenchmarkService.gapAmount(own, stats.median_rate);
      insights.push({
        code: 'BELOW_MEDIAN',
        severity: InsightSeverity.ACTION,
        message: `Your savings rate of ${own.savings_rate}% is below the ${stats.median_rate}% median of ${peers}.`,
        suggestion: `Saving an extra ${amount} per period would bring you to the median.`,
      });
    } else {
      const amount = BenchmarkService.gapAmount(own, stats.p75_rate);
      insights.push({
        code: 'ABOVE_MEDIAN',
        severity: InsightSeverity.NEUTRAL,
        message: `You save more than the typical member of ${peers}.`,
        suggestion:
          amount > 0
            ? `Saving an extra ${amount} per period would put you in the top quarter.`
            : undefined,
      });
    }

    if (own.savings_rate >= TARGET_SAVINGS_RATE) {
      insights.push({
        code: 'MEETS_TARGET',
        severity: InsightSeverity.POSITIVE,
        message: `You are meeting the ${TARGET_SAVINGS_RATE}% savings guideline.`,
      });
    } else if (own.savings_rate > 0) {
      const amount = BenchmarkService.gapAmount(own, TARGET_SAVINGS_RATE);
      insights.push({
        code: 'BELOW_TARGET',
        severity: InsightSeverity.ACTION,
        message: `You are saving ${own.savings_rate}% of income, under the ${TARGET_SAVINGS_RATE}% guideline.`,
        suggestion: `Automate an extra ${amount} per period to reach ${TARGET_SAVINGS_RATE}%.`,
      });
    }

    if (direction === 'declining') {
      const prev = trend[trend.length - 2];
      insights.push({
        code: 'TREND_DECLINING',
        severity: InsightSeverity.ACTION,
        message: `Your savings rate fell from ${prev.savings_rate}% in ${prev.period} to ${own.savings_rate}%.`,
        suggestion: 'Review recent spending or set up a recurring deposit to stay on track.',
      });
    } else if (direction === 'improving') {
      const prev = trend[trend.length - 2];
      insights.push({
        code: 'TREND_IMPROVING',
        severity: InsightSeverity.POSITIVE,
        message: `Your savings rate rose from ${prev.savings_rate}% in ${prev.period} to ${own.savings_rate}%.`,
      });
    }

    return insights;
  }

  private describeCohort(stats: CohortStatsDto): string {
    switch (stats.scope) {
      case CohortScope.INCOME_AND_AGE:
        return 'savers with similar income and age';
      case CohortScope.INCOME:
        return 'savers with similar income';
      default:
        return 'all savers';
    }
  }
}
