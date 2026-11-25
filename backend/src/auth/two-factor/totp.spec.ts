import {
  base32Decode,
  base32Encode,
  buildOtpauthUrl,
  generateTotpForCounter,
  generateTotpSecret,
  matchTotpCounter,
  totpCounterAt,
} from './totp';

// RFC 6238, Appendix B: SHA-1 secret is the ASCII string "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP helpers', () => {
  it('round-trips base32 encoding', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('matches the RFC 6238 SHA-1 test vectors (6 digits)', () => {
    // Each vector is the RFC's 8-digit value truncated to its last six digits.
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ];
    for (const [seconds, expected] of vectors) {
      const counter = totpCounterAt(seconds * 1000);
      expect(generateTotpForCounter(RFC_SECRET, counter)).toBe(expected);
    }
  });

  it('accepts codes within one step of the current time and rejects others', () => {
    const now = 1111111111 * 1000;
    const counter = totpCounterAt(now);
    const previous = generateTotpForCounter(RFC_SECRET, counter - 1);
    const current = generateTotpForCounter(RFC_SECRET, counter);
    const farPast = generateTotpForCounter(RFC_SECRET, counter - 5);

    expect(matchTotpCounter(RFC_SECRET, previous, now)).toBe(counter - 1);
    expect(matchTotpCounter(RFC_SECRET, current, now)).toBe(counter);
    expect(matchTotpCounter(RFC_SECRET, farPast, now)).toBeNull();
    expect(matchTotpCounter(RFC_SECRET, 'abcdef', now)).toBeNull();
    expect(matchTotpCounter(RFC_SECRET, '12345', now)).toBeNull();
  });

  it('generates random secrets of 32 base32 characters', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(a).not.toEqual(b);
  });

  it('builds an otpauth URI with issuer, label and secret', () => {
    const url = buildOtpauthUrl('Stow', 'user@example.com', 'JBSWY3DPEHPK3PXP');
    expect(url.startsWith('otpauth://totp/Stow:user%40example.com?')).toBe(
      true,
    );
    expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(url).toContain('issuer=Stow');
  });
});
