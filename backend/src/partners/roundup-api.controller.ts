import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';

import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { PartnerThrottlerGuard } from './guards/partner-throttler.guard';
import { Scopes } from '../common/decorators/scopes.decorator';
import { PartnerTransactionDto } from './dto/partner-transaction.dto';
import { RoundupApiService } from './roundup-api.service';
import { ApiKey } from '../auth/entities/api-key.entity';

interface AuthenticatedRequest extends ExpressRequest {
  apiKey: ApiKey;
}

/**
 * Partner Roundup API
 *
 * Authentication: X-API-Key header with a key that holds the
 * `partner:roundup` scope.  Missing or invalid keys → 401.
 * Revoked keys → 401.  Missing scope → 403.
 *
 * Rate limiting: per-partner bucket via PartnerThrottlerGuard
 * (defaults: 60 req / 60 s, configurable via env).
 */
@ApiTags('Partner Roundup API')
@ApiSecurity('api-key')
@Controller('partners/roundup')
@UseGuards(ApiKeyGuard, PartnerThrottlerGuard)
@Scopes('partner:roundup')
export class RoundupApiController {
  constructor(private readonly roundupApiService: RoundupApiService) {}

  /**
   * POST /api/v1/partners/roundup/transactions
   *
   * Submit a transaction for round-up processing.
   *
   * - Calculates the round-up amount for the transaction.
   * - Deposits the round-up to the user's savings account.
   * - Sends a signed webhook callback to the partner (async, fire-and-forget).
   * - Idempotent: replaying the same `partner_transaction_id` returns the
   *   original result without a second deposit.
   */
  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Submit a transaction for round-up processing',
    description:
      'Calculates the round-up for the given transaction amount and deposits ' +
      "it to the referenced user's savings account.  Idempotent: the same " +
      'partner_transaction_id returns the original result.',
  })
  @ApiResponse({
    status: 200,
    description: 'Round-up processed (or idempotent replay)',
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({
    status: 403,
    description: 'API key lacks partner:roundup scope',
  })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async submitTransaction(
    @Request() req: AuthenticatedRequest,
    @Body() dto: PartnerTransactionDto,
  ) {
    return this.roundupApiService.processTransaction(req.apiKey, dto);
  }
}
