import { IsOptional, IsString, IsNumber, IsBoolean, IsArray, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class AccountComparisonQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  min_apy?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  max_lock_period?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  allows_withdrawal?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

export class ProjectEarningsDto {
  @IsString()
  account_type: string;

  @IsNumber()
  @Min(0)
  deposit_amount: number;

  @IsNumber()
  @Min(1)
  @Max(3650)
  days: number;
}

export class AccountComparisonResponseDto {
  id: string;
  type: string;
  name: string;
  description: string;
  icon: string | null;
  apy: number;
  lock_period_days: number | null;
  allows_withdrawal: boolean;
  early_withdrawal_penalty: boolean;
  early_withdrawal_penalty_percent: number;
  minimum_deposit: string | null;
  maximum_deposit: string | null;
  features: string[];
  pros: string[];
  cons: string[];
  projected_earnings?: {
    daily: number;
    weekly: number;
    monthly: number;
    yearly: number;
  };
}