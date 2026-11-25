import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** RFC 6238 time step, in seconds. Matches the default used by authenticator apps. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32 character in TOTP secret');
    }
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generates a fresh 160-bit TOTP secret, base32 encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Returns the RFC 6238 counter for a timestamp in milliseconds. */
export function totpCounterAt(timestampMs: number): number {
  return Math.floor(timestampMs / 1000 / TOTP_STEP_SECONDS);
}

/** HOTP (RFC 4226) value for a given counter, using HMAC-SHA1. */
export function generateTotpForCounter(
  secret: string,
  counter: number,
  digits = TOTP_DIGITS,
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret))
    .update(message)
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * Checks `code` against the counters within `window` steps of `nowMs`.
 * Returns the matching counter, or `null` if nothing matches.
 */
export function matchTotpCounter(
  secret: string,
  code: string,
  nowMs: number = Date.now(),
  window = 1,
): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  const current = totpCounterAt(nowMs);
  const submitted = Buffer.from(code);
  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset++) {
    const counter = current + offset;
    const expected = Buffer.from(generateTotpForCounter(secret, counter));
    if (
      expected.length === submitted.length &&
      timingSafeEqual(expected, submitted)
    ) {
      matched = counter;
    }
  }
  return matched;
}

/** Builds the `otpauth://` URI that authenticator apps and QR codes encode. */
export function buildOtpauthUrl(
  issuer: string,
  accountLabel: string,
  secret: string,
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountLabel)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
