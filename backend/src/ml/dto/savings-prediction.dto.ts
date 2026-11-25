import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SUPPORTED_CONFIDENCE_LEVELS } from '../savings-prediction.service';

export class DepositRecordDto {
  @ApiProperty({ example: 150, description: 'Deposit amount in whole currency units' })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiProperty({ example: '2026-10-05T09:30:00Z' })
  @IsDateString()
  timestamp: string;
}

export class TrainSavingsPredictionDto {
  @ApiProperty({ type: [DepositRecordDto], description: 'Historical deposits' })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DepositRecordDto)
  deposits: DepositRecordDto[];

  @ApiPropertyOptional({
    description: 'Point in time the history runs up to (defaults to the latest deposit)',
  })
  @IsOptional()
  @IsDateString()
  asOf?: string;
}

export class SavingsPredictionQueryDto {
  @ApiPropertyOptional({ default: 12, minimum: 1, maximum: 520 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(520)
  horizonWeeks?: number;

  @ApiPropertyOptional({ default: 0.9, enum: SUPPORTED_CONFIDENCE_LEVELS })
  @IsOptional()
  @Type(() => Number)
  @IsIn(SUPPORTED_CONFIDENCE_LEVELS)
  confidence?: number;

  @ApiPropertyOptional({ default: 0, description: 'Current savings balance' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  currentBalance?: number;
}

export class GoalRecommendationDto {
  @ApiPropertyOptional({ description: 'Goal amount; omit to get a suggested target' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  targetAmount?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  currentSaved?: number;

  @ApiPropertyOptional({ example: '2027-06-30T00:00:00Z' })
  @IsOptional()
  @IsDateString()
  deadline?: string;

  @ApiPropertyOptional({ default: 12, minimum: 1, maximum: 520 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(520)
  horizonWeeks?: number;

  @ApiPropertyOptional({ default: 0.9, enum: SUPPORTED_CONFIDENCE_LEVELS })
  @IsOptional()
  @IsIn(SUPPORTED_CONFIDENCE_LEVELS)
  confidence?: number;
}
