import { IsString, IsOptional, IsArray, IsEnum, ValidateNested, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DisputeReason, DisputeStatus } from '../entities/transaction-dispute.entity';

export class CreateDisputeDto {
  @ApiProperty({ description: 'The transaction ID to dispute' })
  @IsString()
  transaction_id: string;

  @ApiProperty({ enum: DisputeReason, description: 'Reason for the dispute' })
  @IsEnum(DisputeReason)
  reason: DisputeReason;

  @ApiProperty({ description: 'Detailed description of the issue' })
  @IsString()
  description: string;

  @ApiPropertyOptional({ description: 'Evidence files or links' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EvidenceDto)
  evidence?: EvidenceDto[];
}

export class EvidenceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateDisputeStatusDto {
  @ApiProperty({ enum: DisputeStatus })
  @IsEnum(DisputeStatus)
  status: DisputeStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assigned_to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  resolution_notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  resolution_outcome?: string;
}

export class DisputeQueryDto {
  @ApiPropertyOptional({ enum: DisputeStatus })
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  user_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

export class DisputeResponseDto {
  id: string;
  user_id: string;
  transaction_id: string;
  reason: DisputeReason;
  description: string;
  evidence: EvidenceDto[] | null;
  status: DisputeStatus;
  assigned_to: string | null;
  resolution_notes: string | null;
  resolution_outcome: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}