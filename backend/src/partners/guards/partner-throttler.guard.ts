import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerModuleOptions } from '@nestjs/throttler/dist/throttler-module-options.interface';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

/**
 * Per-partner rate-limiting guard.
 *
 * Uses the partner's ApiKey `id` as the throttle bucket key so that each
 * partner has an isolated limit and one partner's bursts do not consume
 * another's quota.
 *
 * The guard extends `TieredThrottlerGuard`'s approach but always targets
 * the `partner` tier so it can be applied directly without a decorator.
 *
 * Config env vars (all optional, with defaults):
 *   PARTNER_ROUNDUP_THROTTLE_LIMIT   – requests per window (default 60)
 *   PARTNER_ROUNDUP_THROTTLE_TTL_MS  – window length in ms  (default 60 000)
 */
@Injectable()
export class PartnerThrottlerGuard extends ThrottlerGuard {
  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    // These two are injected but only used to satisfy the base-class
    // constructor chain via the ThrottlerModule DI graph.
    private readonly _jwtService: JwtService,
    private readonly _configService: ConfigService,
  ) {
    super(options, storageService, reflector);
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const partnerTier = this.throttlers.filter((t) => t.name === 'partner');
    if (partnerTier.length === 0) {
      // No partner tier configured – fall through (no-op guard).
      return true;
    }
    const original = this.throttlers;
    this.throttlers = partnerTier;
    try {
      return await super.canActivate(context);
    } finally {
      this.throttlers = original;
    }
  }

  /**
   * Use the partner's API-key ID as the tracker so each partner has
   * its own isolated bucket.  Falls back to IP when no key is present
   * (which the ApiKeyGuard should have already rejected, so this is
   * defensive only).
   */
  protected override async getTracker(
    req: Record<string, any>,
  ): Promise<string> {
    const apiKeyId: string | undefined = req.apiKey?.id;
    if (apiKeyId) {
      return `partner:${apiKeyId}`;
    }
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }

  protected override generateKey(
    context: ExecutionContext,
    suffix: string,
    name: string,
  ): string {
    const req = context.switchToHttp().getRequest();
    const tracker = req.apiKey?.id
      ? `partner:${req.apiKey.id}`
      : (req.ip ?? 'unknown');
    return `throttle:${name}:${tracker}:${suffix}`;
  }
}
