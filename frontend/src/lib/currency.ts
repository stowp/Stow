/**
 * Locale-aware currency and number display.
 *
 * Stow moves two kinds of amounts around:
 *  - "stroops" — the on-chain integer base unit (1 XLM = 10,000,000 stroops),
 *    always carried as a string to avoid JS number precision loss on large
 *    i128 values (see the `savings` entities' comments on this repo).
 *  - plain decimal amounts for off-chain/anchor currencies (e.g. USDC, or a
 *    user's local fiat currency during a ramp deposit/withdrawal).
 *
 * All display formatting here goes through `Intl.NumberFormat` so grouping
 * separators, decimal marks, and currency symbol placement match the
 * viewer's locale instead of being hardcoded to `en-US`. Parsing (turning a
 * user-typed or formatted string back into a number) is kept locale-safe by
 * normalizing the locale's actual group/decimal separators rather than
 * assuming "," and ".".
 */

/** Stroops per XLM (Stellar's on-chain base unit): 1 XLM = 10,000,000 stroops. */
export const STROOPS_PER_XLM = 10_000_000;

/** Falls back to the runtime default when no explicit locale is given. */
function resolveLocale(locale?: string): string | undefined {
  return locale ?? undefined;
}

/**
 * Formats a plain number as a locale-aware decimal string (no currency
 * symbol), e.g. `formatNumber(1234.5)` -> "1,234.5" in en-US or "1.234,5" in
 * de-DE.
 *
 * Falls back to a safe default if `locale` isn't recognized by the runtime's
 * ICU data, and to `"0"` for non-finite input, rather than throwing.
 */
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions & { locale?: string },
): string {
  const { locale, ...rest } = options ?? {};
  if (!Number.isFinite(value)) return "0";

  try {
    return new Intl.NumberFormat(resolveLocale(locale), rest).format(value);
  } catch {
    // Unrecognized locale/options (e.g. an invalid BCP 47 tag) — fall back
    // to the runtime default rather than crashing the render.
    return new Intl.NumberFormat(undefined, rest).format(value);
  }
}

export interface FormatCurrencyOptions {
  /** BCP 47 locale tag, e.g. "en-US", "de-DE". Defaults to the runtime locale. */
  locale?: string;
  /** Minimum fraction digits to display. Defaults to `currency`'s minor unit (2 for most, 0 for JPY, etc). */
  minimumFractionDigits?: number;
  /** Maximum fraction digits to display. */
  maximumFractionDigits?: number;
}

/**
 * Formats `value` as a currency amount using `Intl.NumberFormat`, honoring
 * the active locale's grouping, decimal separator, and symbol placement.
 *
 * `currency` must be a valid ISO 4217 code (e.g. "USD", "EUR"). Stellar/
 * Soroban assets like "XLM" or "USDC" are not ISO 4217 currencies, so for
 * those use `formatAssetAmount` instead.
 */
export function formatCurrency(
  value: number,
  currency: string,
  options?: FormatCurrencyOptions,
): string {
  if (!Number.isFinite(value)) value = 0;

  const { locale, ...rest } = options ?? {};
  const formatOptions: Intl.NumberFormatOptions = {
    style: "currency",
    currency,
    ...rest,
  };

  try {
    return new Intl.NumberFormat(resolveLocale(locale), formatOptions).format(
      value,
    );
  } catch {
    // Unknown/invalid currency code or locale tag — fall back to a plain
    // "CODE amount" rendering so display never throws on bad input.
    const amount = new Intl.NumberFormat(resolveLocale(locale), {
      minimumFractionDigits: rest.minimumFractionDigits,
      maximumFractionDigits: rest.maximumFractionDigits,
    }).format(value);
    return `${currency} ${amount}`;
  }
}

/**
 * Formats a non-ISO 4217 asset amount (e.g. XLM, USDC) with locale-aware
 * grouping, since `Intl.NumberFormat`'s `style: "currency"` only accepts
 * ISO 4217 codes.
 */
export function formatAssetAmount(
  value: number,
  assetCode: string,
  options?: { locale?: string; maximumFractionDigits?: number },
): string {
  const { locale, maximumFractionDigits = 7 } = options ?? {};
  const amount = formatNumber(value, {
    locale,
    maximumFractionDigits,
  });
  return `${amount} ${assetCode}`;
}

/**
 * Converts a stroop amount (as carried by the API/entities, a string to
 * avoid precision loss) to a plain, locale-grouped number string with no
 * asset code suffix, e.g. `formatStroopsAmount("25000000000")` -> "2,500".
 *
 * Useful when a single asset-code suffix is shared across multiple amounts
 * in the same line (e.g. "2.5 / 10 XLM") — see `formatStroops` for the
 * common case of one amount plus its suffix together.
 */
export function formatStroopsAmount(
  stroops: string,
  options?: { locale?: string; maximumFractionDigits?: number },
): string {
  const { locale, maximumFractionDigits = 7 } = options ?? {};
  const value = Number(stroops) / STROOPS_PER_XLM;
  return formatNumber(value, { locale, maximumFractionDigits });
}

/**
 * Converts a stroop amount (as carried by the API/entities, a string to
 * avoid precision loss) into a display string for the given asset, e.g.
 * `formatStroops("25000000000", "XLM")` -> "2,500 XLM".
 */
export function formatStroops(
  stroops: string,
  assetCode = "XLM",
  options?: { locale?: string; maximumFractionDigits?: number },
): string {
  const value = Number(stroops) / STROOPS_PER_XLM;
  return formatAssetAmount(value, assetCode, options);
}

/**
 * Locale-safe parsing of a user-typed or formatted numeric string back into
 * a `number`. Detects the active locale's actual group and decimal
 * separators (via a probe format of `Intl.NumberFormat`) instead of
 * assuming "," is always the group separator and "." the decimal point —
 * that assumption breaks for locales like de-DE ("1.234,56") or fr-FR
 * ("1 234,56").
 *
 * Returns `NaN` for input that isn't parseable as a number, mirroring
 * `Number()`/`parseFloat()` semantics so callers can validate with
 * `Number.isNaN`.
 */
export function parseLocaleNumber(input: string, locale?: string): number {
  const trimmed = input.trim();
  if (trimmed === "") return NaN;

  const parts = new Intl.NumberFormat(resolveLocale(locale)).formatToParts(
    1234.5,
  );
  const groupSeparator = parts.find((p) => p.type === "group")?.value ?? ",";
  const decimalSeparator =
    parts.find((p) => p.type === "decimal")?.value ?? ".";

  // Strip anything that isn't a digit, the locale's decimal separator, or a
  // leading minus sign, then normalize the decimal separator to ".".
  const isNegative = /^\s*-/.test(trimmed);
  const groupPattern = new RegExp(
    `[${groupSeparator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s]`,
    "g",
  );
  const cleaned = trimmed
    .replace(groupPattern, "")
    .replace(decimalSeparator, ".")
    .replace(/[^\d.-]/g, "");

  const value = Number(cleaned);
  if (Number.isNaN(value)) return NaN;

  return isNegative && value > 0 ? -value : value;
}

/**
 * Formats yield amounts (position value, harvest history, APR) using
 * locale-aware number formatting to match the rest of the app's monetary
 * value display.
 *
 * Use this for all yield UI surfaces to ensure consistent formatting
 * across supported locales.
 */
export function formatYieldAmount(
  value: number,
  options?: { locale?: string; maximumFractionDigits?: number },
): string {
  const { locale, maximumFractionDigits = 7 } = options ?? {};
  return formatNumber(value, { locale, maximumFractionDigits });
}

/**
 * Formats APR (annual percentage rate) as a locale-aware percentage.
 *
 * Use this for all APR displays in yield-related UI.
 */
export function formatAPR(
  value: number,
  options?: { locale?: string; maximumFractionDigits?: number },
): string {
  const { locale, maximumFractionDigits = 2 } = options ?? {};
  const amount = formatNumber(value, { locale, maximumFractionDigits });
  return `${amount}%`;
}

// ---------------------------------------------------------------------------
// USDC (7-decimal stroops)
// ---------------------------------------------------------------------------
//
// USDC on Stellar/Soroban is carried on-chain as an i128 of 7-decimal base
// units ("stroops"). The helpers below never route an amount through a JS
// `number`: formatting splits the `bigint` into whole/fractional parts and
// parsing builds the `bigint` from the typed digits, so any value
// round-trips exactly, however large.

/** Decimal places of USDC on Stellar (1 USDC = 10,000,000 stroops). */
export const USDC_DECIMALS = 7;

/** Stroops per whole USDC, as a `bigint`. */
// `BigInt(...)` rather than `n` literals: tsconfig targets ES2017.
const ZERO = BigInt(0);
const ONE = BigInt(1);

export const STROOPS_PER_USDC = BigInt(10) ** BigInt(USDC_DECIMALS);

interface LocaleSeparators {
  group: string;
  decimal: string;
}

/** The locale's actual group and decimal separators (e.g. "." and "," in de-DE). */
export function getLocaleSeparators(locale?: string): LocaleSeparators {
  let parts: Intl.NumberFormatPart[];
  try {
    parts = new Intl.NumberFormat(resolveLocale(locale)).formatToParts(
      1234567.5,
    );
  } catch {
    parts = new Intl.NumberFormat().formatToParts(1234567.5);
  }
  return {
    group: parts.find((p) => p.type === "group")?.value ?? ",",
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
  };
}

function toBigInt(stroops: string | bigint): bigint | null {
  if (typeof stroops === "bigint") return stroops;
  const trimmed = stroops.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

export interface FormatUsdcOptions {
  /** BCP 47 locale tag. Defaults to the runtime locale. */
  locale?: string;
  /** Digits kept after the decimal mark (0–7). Extra digits are truncated, never rounded up. Defaults to 7. */
  maximumFractionDigits?: number;
  /** Digits always shown after the decimal mark, zero-padded (0–7). Defaults to 2. */
  minimumFractionDigits?: number;
  /** Insert the locale's group separator. Defaults to `true`. */
  useGrouping?: boolean;
  /** Append " USDC". Defaults to `false`. */
  withSymbol?: boolean;
}

function clampDigits(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(USDC_DECIMALS, Math.max(0, Math.trunc(value)));
}

/**
 * Formats a USDC stroop amount for display without precision loss, e.g.
 * `formatUsdc("12345678900000", { locale: "en-US" })` -> "1,234,567.89".
 *
 * Excess fraction digits beyond `maximumFractionDigits` are truncated
 * (toward zero) rather than rounded, so a displayed balance is never more
 * than what's actually held. Invalid input renders as zero.
 */
export function formatUsdc(
  stroops: string | bigint,
  options?: FormatUsdcOptions,
): string {
  const {
    locale,
    useGrouping = true,
    withSymbol = false,
  } = options ?? {};
  const maxDigits = clampDigits(options?.maximumFractionDigits, USDC_DECIMALS);
  const minDigits = Math.min(
    clampDigits(options?.minimumFractionDigits, 2),
    maxDigits,
  );

  const value = toBigInt(stroops) ?? ZERO;
  const negative = value < ZERO;
  const abs = negative ? -value : value;
  const whole = abs / STROOPS_PER_USDC;
  const fraction = abs % STROOPS_PER_USDC;

  let fractionDigits = fraction
    .toString()
    .padStart(USDC_DECIMALS, "0")
    .slice(0, maxDigits)
    .replace(/0+$/, "");
  if (fractionDigits.length < minDigits) {
    fractionDigits = fractionDigits.padEnd(minDigits, "0");
  }

  const wholeText = formatGroupedInteger(whole, locale, useGrouping);
  const { decimal } = getLocaleSeparators(locale);
  const isZero = whole === ZERO && /^0*$/.test(fractionDigits);
  const sign = negative && !isZero ? "-" : "";
  const amount = fractionDigits
    ? `${sign}${wholeText}${decimal}${fractionDigits}`
    : `${sign}${wholeText}`;

  return withSymbol ? `${amount} USDC` : amount;
}

export type UsdcParseError = "empty" | "invalid" | "too_many_decimals";

export type UsdcParseResult =
  | { ok: true; stroops: bigint }
  | { ok: false; error: UsdcParseError };

function formatGroupedInteger(
  value: bigint,
  locale?: string,
  useGrouping = true,
): string {
  const options = { useGrouping, maximumFractionDigits: 0 };
  try {
    return new Intl.NumberFormat(resolveLocale(locale), options).format(value);
  } catch {
    return new Intl.NumberFormat(undefined, options).format(value);
  }
}

/**
 * Parses a user-typed USDC amount (in `locale`'s notation) into stroops.
 *
 * - Accepts the locale's decimal mark and, optionally, its group separator
 *   — but only in well-formed groups of three (so "1.5" typed in de-DE is
 *   rejected rather than silently read as 15).
 * - Whitespace (including the narrow no-break space fr-FR groups with) is
 *   ignored; a trailing/leading "USDC" label is ignored.
 * - Rejects negatives and more than 7 fraction digits.
 */
export function parseUsdc(input: string, locale?: string): UsdcParseResult {
  const { group, decimal } = getLocaleSeparators(locale);
  const cleaned = input
    .replace(/usdc/gi, "")
    .replace(/\s/g, "")
    .trim();
  if (cleaned === "") return { ok: false, error: "empty" };

  const decimalIndex = cleaned.indexOf(decimal);
  const wholePart =
    decimalIndex === -1 ? cleaned : cleaned.slice(0, decimalIndex);
  const fractionPart =
    decimalIndex === -1 ? "" : cleaned.slice(decimalIndex + decimal.length);

  // Whitespace group separators were already stripped above.
  const groupIsSpace = /^\s$/.test(group);
  let wholeDigits = wholePart;
  if (!groupIsSpace && wholePart.includes(group)) {
    wholeDigits = wholePart.split(group).join("");
    // Grouping must match how this locale itself groups the digits
    // (thousands in en-US, lakh/crore in en-IN, ...).
    if (!/^\d+$/.test(wholeDigits)) return { ok: false, error: "invalid" };
    const canonical = formatGroupedInteger(BigInt(wholeDigits), locale);
    if (canonical !== wholePart) return { ok: false, error: "invalid" };
  }

  if (!/^\d*$/.test(wholeDigits) || !/^\d*$/.test(fractionPart)) {
    return { ok: false, error: "invalid" };
  }
  if (wholeDigits === "" && fractionPart === "") {
    return { ok: false, error: "invalid" };
  }
  if (fractionPart.length > USDC_DECIMALS) {
    return { ok: false, error: "too_many_decimals" };
  }

  const stroops =
    BigInt(wholeDigits || "0") * STROOPS_PER_USDC +
    BigInt(fractionPart.padEnd(USDC_DECIMALS, "0") || "0");
  return { ok: true, stroops };
}

export interface ValidateUsdcOptions {
  locale?: string;
  /** Smallest accepted amount, in stroops. Defaults to 1 (i.e. > 0). */
  min?: bigint;
  /** Largest accepted amount, in stroops (e.g. the user's balance). */
  max?: bigint;
}

export type UsdcValidationResult =
  | { ok: true; stroops: bigint }
  | { ok: false; error: string };

/**
 * Parses and range-checks a typed USDC amount, returning either the stroop
 * value or a user-facing error message.
 */
export function validateUsdcAmount(
  input: string,
  options?: ValidateUsdcOptions,
): UsdcValidationResult {
  const { locale, min = ONE, max } = options ?? {};
  const parsed = parseUsdc(input, locale);
  if (!parsed.ok) {
    switch (parsed.error) {
      case "empty":
        return { ok: false, error: "Enter an amount." };
      case "too_many_decimals":
        return {
          ok: false,
          error: `USDC supports at most ${USDC_DECIMALS} decimal places.`,
        };
      default:
        return { ok: false, error: "Enter a valid amount." };
    }
  }

  if (parsed.stroops < min) {
    return min <= ONE
      ? { ok: false, error: "Amount must be greater than 0." }
      : {
          ok: false,
          error: `Minimum amount is ${formatUsdc(min, { locale, minimumFractionDigits: 0 })} USDC.`,
        };
  }
  if (max !== undefined && parsed.stroops > max) {
    return {
      ok: false,
      error: `Maximum amount is ${formatUsdc(max, { locale, minimumFractionDigits: 0 })} USDC.`,
    };
  }
  return parsed;
}
