import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { TAX_JURISDICTIONS, type TaxJurisdiction } from '../tax-rules';

export const TAX_TRANSACTION_TYPES = [
  'deposit',
  'withdrawal',
  'interest',
] as const;
export type TaxTransactionType = (typeof TAX_TRANSACTION_TYPES)[number];

export const TAX_ACCOUNT_TYPES = ['taxable', 'tax_advantaged'] as const;
export type TaxAccountType = (typeof TAX_ACCOUNT_TYPES)[number];

/** One savings transaction, in the jurisdiction's currency. */
export class TaxTransactionDto {
  @ApiProperty({ enum: TAX_TRANSACTION_TYPES, example: 'deposit' })
  @IsIn(TAX_TRANSACTION_TYPES)
  type: TaxTransactionType;

  @ApiProperty({ example: 500, description: 'Positive amount' })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({ example: '2026-03-01T00:00:00Z' })
  @IsDateString()
  date: string;

  @ApiPropertyOptional({
    enum: TAX_ACCOUNT_TYPES,
    default: 'taxable',
    description: 'Whether the transaction was in a tax-advantaged account',
  })
  @IsOptional()
  @IsIn(TAX_ACCOUNT_TYPES)
  account?: TaxAccountType;
}

export class TaxBalancesDto {
  @ApiProperty({ example: 10_000 })
  @IsNumber()
  @Min(0)
  taxable: number;

  @ApiProperty({ example: 2_000 })
  @IsNumber()
  @Min(0)
  taxAdvantaged: number;
}

/**
 * Body for `POST /tax/optimize`. The jurisdiction is taken from
 * `jurisdiction` if given, else detected from `countryCode`, `locale`, then
 * `currency`.
 */
export class TaxAnalysisRequestDto {
  @ApiPropertyOptional({ enum: TAX_JURISDICTIONS })
  @IsOptional()
  @IsIn(TAX_JURISDICTIONS)
  jurisdiction?: TaxJurisdiction;

  @ApiPropertyOptional({ example: 'GB', description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @IsString()
  countryCode?: string;

  @ApiPropertyOptional({ example: 'en-GB' })
  @IsOptional()
  @IsString()
  locale?: string;

  @ApiPropertyOptional({ example: 'GBP' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({
    example: 45_000,
    description: 'Annual income, used to find the marginal tax rate',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  annualIncome?: number;

  @ApiPropertyOptional({ example: 35, description: 'For early-withdrawal penalties' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(130)
  age?: number;

  @ApiPropertyOptional({
    example: 2026,
    description: 'Tax year to analyse (the year it starts in). Defaults to the year containing `asOf`.',
  })
  @IsOptional()
  @IsInt()
  taxYear?: number;

  @ApiPropertyOptional({
    example: '2026-11-23T00:00:00Z',
    description: 'Date the advice is for. Defaults to now.',
  })
  @IsOptional()
  @IsDateString()
  asOf?: string;

  @ApiPropertyOptional({
    example: 0.045,
    description: 'Expected annual interest rate (decimal) for projections',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  annualInterestRate?: number;

  @ApiPropertyOptional({ type: TaxBalancesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TaxBalancesDto)
  balances?: TaxBalancesDto;

  @ApiPropertyOptional({
    example: 3_000,
    description: 'Amount the user wants to withdraw, for a withdrawal strategy',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  plannedWithdrawal?: number;

  @ApiProperty({ type: [TaxTransactionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaxTransactionDto)
  transactions: TaxTransactionDto[];
}

/** Body for `POST /tax/documents`: the analysis input plus the holder's details. */
export class TaxDocumentRequestDto extends TaxAnalysisRequestDto {
  @ApiPropertyOptional({ example: 'Stow Savings' })
  @IsOptional()
  @IsString()
  payerName?: string;

  @ApiPropertyOptional({ example: 'Ada Lovelace' })
  @IsOptional()
  @IsString()
  recipientName?: string;

  @ApiPropertyOptional({
    example: '***-**-1234',
    description: 'Tax id (SSN / UTR / SIN / Steuer-ID / TIN); masked values are fine',
  })
  @IsOptional()
  @IsString()
  taxId?: string;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type JurisdictionSource =
  | 'explicit'
  | 'countryCode'
  | 'locale'
  | 'currency'
  | 'default';

export class JurisdictionDetectionDto {
  @ApiProperty({ enum: TAX_JURISDICTIONS })
  jurisdiction: TaxJurisdiction;

  @ApiProperty()
  name: string;

  @ApiProperty()
  currency: string;

  @ApiProperty({
    enum: ['explicit', 'countryCode', 'locale', 'currency', 'default'],
  })
  detectedFrom: JurisdictionSource;
}

export class TaxYearDto {
  @ApiProperty({ example: 2026 })
  year: number;

  @ApiProperty({ example: '2026-01-01' })
  start: string;

  @ApiProperty({ example: '2026-12-31' })
  end: string;
}

export class TransactionPatternDto {
  @ApiProperty() totalDeposits: number;
  @ApiProperty() totalWithdrawals: number;
  @ApiProperty() depositCount: number;
  @ApiProperty() averageDeposit: number;
  @ApiProperty() taxableInterest: number;
  @ApiProperty() taxAdvantagedInterest: number;
  @ApiProperty() taxAdvantagedContributions: number;
  @ApiProperty({ description: 'Allowance for tax-advantaged contributions (0 if none)' })
  contributionAllowance: number;
  @ApiProperty() remainingContributionAllowance: number;
  @ApiProperty({ description: 'Share of deposits made in the last quarter of the tax year' })
  lateYearDepositShare: number;
}

export class TaxEstimateDto {
  @ApiProperty() taxableInterest: number;
  @ApiProperty({ description: 'Tax-free interest allowance applied' })
  allowanceApplied: number;
  @ApiProperty() taxableAfterAllowance: number;
  @ApiProperty({ description: 'Rate applied to interest (decimal)' })
  rate: number;
  @ApiProperty() estimatedTax: number;
  @ApiProperty({ description: 'estimatedTax / taxableInterest' })
  effectiveRate: number;
}

export const TAX_SUGGESTION_TYPES = [
  'use_tax_advantaged_allowance',
  'prior_year_contribution',
  'shift_to_tax_advantaged',
  'wait_for_new_tax_year',
  'interest_allowance_headroom',
  'claim_allowance',
  'final_withholding',
] as const;
export type TaxSuggestionType = (typeof TAX_SUGGESTION_TYPES)[number];

export class TaxSuggestionDto {
  @ApiProperty({ enum: TAX_SUGGESTION_TYPES })
  type: TaxSuggestionType;

  @ApiProperty({ enum: ['high', 'medium', 'low'] })
  priority: 'high' | 'medium' | 'low';

  @ApiProperty() title: string;
  @ApiProperty() description: string;

  @ApiPropertyOptional({ description: 'Suggested amount, if any' })
  amount?: number;

  @ApiPropertyOptional({ description: 'Act on or before this date (YYYY-MM-DD)' })
  deadline?: string;

  @ApiPropertyOptional({ description: 'Act on or after this date (YYYY-MM-DD)' })
  recommendedDate?: string;

  @ApiProperty({ description: 'Estimated tax saved per year by acting' })
  estimatedTaxSaving: number;

  @ApiProperty({ description: 'The jurisdiction rule the suggestion relies on' })
  rule: string;
}

export class WithdrawalStepDto {
  @ApiProperty({ enum: TAX_ACCOUNT_TYPES }) source: TaxAccountType;
  @ApiProperty() amount: number;
  @ApiProperty({ description: 'Tax and penalties due on this withdrawal' })
  immediateTax: number;
}

export class WithdrawalOptionDto {
  @ApiProperty({ example: 'taxable_first' }) name: string;
  @ApiProperty({ type: [WithdrawalStepDto] }) steps: WithdrawalStepDto[];
  @ApiProperty() immediateTax: number;
  @ApiProperty({
    description: 'Tax over the next year on interest from what remains in taxable savings',
  })
  futureInterestTax: number;
  @ApiProperty() totalTaxCost: number;
}

export class WithdrawalStrategyDto {
  @ApiProperty() amount: number;
  @ApiProperty({ description: 'False when balances cannot cover the amount' })
  feasible: boolean;
  @ApiProperty({ type: WithdrawalOptionDto }) recommended: WithdrawalOptionDto;
  @ApiProperty({ type: [WithdrawalOptionDto] }) alternatives: WithdrawalOptionDto[];
  @ApiProperty({ description: 'Tax saved versus the costliest option' })
  taxSaved: number;
  @ApiProperty() rationale: string;
}

export class TaxDocumentFieldDto {
  @ApiProperty() key: string;
  @ApiProperty() label: string;
  @ApiProperty({ nullable: true, type: String }) value: string | null;
  @ApiProperty() required: boolean;
}

export class TaxDocumentTemplateDto {
  @ApiProperty({ enum: TAX_JURISDICTIONS }) jurisdiction: TaxJurisdiction;
  @ApiProperty() form: string;
  @ApiProperty() title: string;
  @ApiProperty() taxYear: TaxYearDto;
  @ApiProperty() currency: string;
  @ApiProperty({ type: [TaxDocumentFieldDto] }) fields: TaxDocumentFieldDto[];
  @ApiProperty({ type: [String], description: 'Required fields with no value yet' })
  missingFields: string[];
  @ApiProperty({ description: 'Whether interest meets the reporting threshold' })
  reportingRequired: boolean;
  @ApiProperty({ type: [String] }) notes: string[];
}

export class TaxOptimizationResponseDto {
  @ApiProperty({ type: JurisdictionDetectionDto }) jurisdiction: JurisdictionDetectionDto;
  @ApiProperty({ type: TaxYearDto }) taxYear: TaxYearDto;
  @ApiProperty({ description: 'Marginal rate used for interest (decimal)' })
  marginalRate: number;
  @ApiProperty({ type: TransactionPatternDto }) analysis: TransactionPatternDto;
  @ApiProperty({ type: TaxEstimateDto }) taxEstimate: TaxEstimateDto;
  @ApiProperty({ type: [TaxSuggestionDto] }) suggestions: TaxSuggestionDto[];
  @ApiPropertyOptional({ type: WithdrawalStrategyDto })
  withdrawalStrategy?: WithdrawalStrategyDto;
  @ApiProperty() disclaimer: string;
}
