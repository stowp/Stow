import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsInt,
  IsPositive,
  MaxLength,
  Matches,
  IsOptional,
  IsDateString,
  ValidateNested,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Metadata attached to a partner transaction.
 * All fields are optional and informational only.
 */
export class PartnerTransactionMetadataDto {
  @ApiPropertyOptional({ description: 'Merchant or category tag' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  category?: string;

  @ApiPropertyOptional({
    description: 'Human-readable description of the transaction',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

/**
 * Request body for POST /api/v1/partners/roundup/transactions.
 *
 * amount:
 *   Integer minor units (e.g. stroops for XLM/USDC, cents for USD).
 *   Must be a positive integer ≥ 1.
 *   Floating-point money is explicitly rejected — the type is `number`
 *   but the @IsInt validator ensures it arrives as an integer.
 *
 * currency:
 *   ISO 4217 three-letter uppercase code (e.g. "USD", "USDC", "XLM").
 *
 * partner_transaction_id:
 *   Idempotency key scoped to the partner.  The same value submitted
 *   twice returns the original result without a second deposit.
 *
 * user_reference:
 *   The platform's user identifier for the account to credit.
 *   Validated as a non-empty string; the service resolves it to an
 *   internal account via BalanceService.
 */
export class PartnerTransactionDto {
  @ApiProperty({
    description:
      "Idempotency key: a unique ID for this transaction within the partner's system. " +
      'Replaying the same value returns the original result without a second deposit.',
    example: 'txn_partner_abc_123',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  partner_transaction_id: string;

  @ApiProperty({
    description: 'Platform user reference (stellar address or user id)',
    example: 'GABC...XYZ',
    maxLength: 256,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  user_reference: string;

  @ApiProperty({
    description:
      'Transaction amount in integer minor units (e.g. stroops or cents). ' +
      'Must be a positive integer ≥ 1.  Floating-point values are rejected.',
    example: 12340000,
  })
  @IsInt({ message: 'amount must be an integer (minor units, no decimals)' })
  @IsPositive({ message: 'amount must be a positive integer ≥ 1' })
  amount: number;

  @ApiProperty({
    description: 'ISO 4217 three-letter currency code (uppercase)',
    example: 'USD',
    pattern: '^[A-Z]{3,4}$',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{3,4}$/, {
    message: 'currency must be a 3–4 character uppercase ISO 4217 code',
  })
  currency: string;

  @ApiProperty({
    description: 'ISO 8601 timestamp of when the transaction occurred',
    example: '2024-01-15T10:30:00.000Z',
  })
  @IsDateString(
    {},
    { message: 'timestamp must be a valid ISO 8601 date-time string' },
  )
  timestamp: string;

  @ApiPropertyOptional({
    description: 'Optional metadata attached to this transaction',
    type: PartnerTransactionMetadataDto,
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PartnerTransactionMetadataDto)
  metadata?: PartnerTransactionMetadataDto;
}
