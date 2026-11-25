import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNumber,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Annual-income brackets used for demographic grouping (USD). */
export enum IncomeBracket {
  UNDER_25K = 'under_25k',
  FROM_25K_TO_50K = '25k_50k',
  FROM_50K_TO_100K = '50k_100k',
  FROM_100K_TO_200K = '100k_200k',
  OVER_200K = 'over_200k',
}

/** Age brackets used for demographic grouping. */
export enum AgeBracket {
  UNDER_25 = 'under_25',
  FROM_25_TO_34 = '25_34',
  FROM_35_TO_44 = '35_44',
  FROM_45_TO_54 = '45_54',
  FROM_55_TO_64 = '55_64',
  OVER_64 = '65_plus',
}

/**
 * The peer group a user was compared against. When the user's exact
 * income+age cohort is too small to stay anonymous, the comparison widens
 * to income-only, then to all users.
 */
export enum CohortScope {
  INCOME_AND_AGE = 'income_and_age',
  INCOME = 'income',
  ALL = 'all',
}

export enum InsightSeverity {
  POSITIVE = 'positive',
  NEUTRAL = 'neutral',
  ACTION = 'action',
}

/** Input for recording one period of a user's savings activity. */
export class RecordBenchmarkSnapshotDto {
  @ApiProperty({
    description: 'Period the snapshot covers (YYYY-MM)',
    example: '2026-10',
  })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  period: string;

  @ApiProperty({ description: 'Income earned in the period (USD)', example: 4000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  income: number;

  @ApiProperty({ description: 'Amount saved in the period (USD)', example: 600 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  saved: number;

  @ApiProperty({ description: 'User age in years', example: 31 })
  @Type(() => Number)
  @IsInt()
  @Min(16)
  @Max(120)
  age: number;
}

export class BenchmarkQueryDto {
  @ApiPropertyOptional({
    description: 'Period to benchmark (YYYY-MM). Defaults to the latest recorded period.',
    example: '2026-10',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  period?: string;
}

/** Anonymized distribution of savings rates within a cohort. */
export class CohortStatsDto {
  @ApiProperty({ enum: CohortScope })
  scope: CohortScope;

  @ApiProperty({ enum: IncomeBracket, nullable: true })
  income_bracket: IncomeBracket | null;

  @ApiProperty({ enum: AgeBracket, nullable: true })
  age_bracket: AgeBracket | null;

  @ApiProperty({ description: 'Number of users in the cohort (never below the anonymity threshold)' })
  size: number;

  @ApiProperty({ description: 'Mean savings rate, percent' })
  mean_rate: number;

  @ApiProperty({ description: 'Median savings rate, percent' })
  median_rate: number;

  @ApiProperty({ description: '25th-percentile savings rate, percent' })
  p25_rate: number;

  @ApiProperty({ description: '75th-percentile savings rate, percent' })
  p75_rate: number;
}

export class BenchmarkInsightDto {
  @ApiProperty()
  code: string;

  @ApiProperty({ enum: InsightSeverity })
  severity: InsightSeverity;

  @ApiProperty()
  message: string;

  @ApiPropertyOptional({ description: 'Concrete next step for the user' })
  suggestion?: string;
}

export class BenchmarkTrendPointDto {
  @ApiProperty({ example: '2026-10' })
  period: string;

  @ApiProperty({ description: 'Savings rate in the period, percent' })
  savings_rate: number;

  @ApiProperty({ description: 'Percentile rank within the cohort for that period' })
  percentile: number;

  @ApiProperty({ description: 'Cohort median for that period, percent' })
  cohort_median_rate: number;
}

export class BenchmarkDataDto {
  @ApiProperty({ example: '2026-10' })
  period: string;

  @ApiProperty({ description: 'User savings rate (saved / income), percent' })
  savings_rate: number;

  @ApiProperty({ description: 'Percentile rank (0-100) within the comparison cohort' })
  percentile: number;

  @ApiProperty({ description: 'Percentile rank (0-100) across all users' })
  overall_percentile: number;

  @ApiProperty({ type: CohortStatsDto })
  cohort: CohortStatsDto;

  @ApiProperty({ type: [BenchmarkInsightDto] })
  insights: BenchmarkInsightDto[];

  @ApiProperty({ type: [BenchmarkTrendPointDto] })
  trend: BenchmarkTrendPointDto[];

  @ApiProperty({
    enum: ['improving', 'declining', 'stable', 'insufficient_data'],
  })
  trend_direction: 'improving' | 'declining' | 'stable' | 'insufficient_data';
}
