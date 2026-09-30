import { describe, it, expect } from "vitest";
import {
  formatNumber,
  formatCurrency,
  formatAssetAmount,
  formatStroops,
  formatStroopsAmount,
  parseLocaleNumber,
  STROOPS_PER_XLM,
  STROOPS_PER_USDC,
  USDC_DECIMALS,
  formatUsdc,
  parseUsdc,
  validateUsdcAmount,
} from "./currency";

describe("currency", () => {
  describe("formatNumber", () => {
    it("formats with en-US grouping by default", () => {
      expect(formatNumber(1234.5, { locale: "en-US" })).toBe("1,234.5");
    });

    it("formats with the active locale's grouping and decimal separators", () => {
      expect(formatNumber(1234.5, { locale: "de-DE" })).toBe("1.234,5");
      expect(formatNumber(1234.5, { locale: "fr-FR" })).toMatch(/1.234,5/);
    });

    it("respects fraction digit options", () => {
      expect(
        formatNumber(1234.5678, {
          locale: "en-US",
          maximumFractionDigits: 2,
        }),
      ).toBe("1,234.57");
    });

    it("returns '0' for non-finite input instead of throwing", () => {
      expect(formatNumber(NaN)).toBe("0");
      expect(formatNumber(Infinity)).toBe("0");
      expect(formatNumber(-Infinity)).toBe("0");
    });

    it("falls back to the runtime default locale for an invalid locale tag", () => {
      expect(() => formatNumber(1234, { locale: "not-a-locale-!!" })).not.toThrow();
    });
  });

  describe("formatCurrency", () => {
    it("formats USD with en-US locale", () => {
      expect(formatCurrency(1234.5, "USD", { locale: "en-US" })).toBe(
        "$1,234.50",
      );
    });

    it("formats EUR with de-DE locale (symbol after amount, comma decimal)", () => {
      const result = formatCurrency(1234.5, "EUR", { locale: "de-DE" });
      expect(result).toContain("1.234,50");
      expect(result).toContain("€");
    });

    it("formats JPY with zero fraction digits by default (no minor unit)", () => {
      expect(formatCurrency(1234, "JPY", { locale: "en-US" })).toBe("¥1,234");
    });

    it("treats non-finite values as 0", () => {
      expect(formatCurrency(NaN, "USD", { locale: "en-US" })).toBe("$0.00");
    });

    it("falls back to 'CODE amount' for an invalid ISO 4217 currency code", () => {
      const result = formatCurrency(10, "NOTACODE", { locale: "en-US" });
      expect(result).toBe("NOTACODE 10");
    });

    it("honors explicit fraction digit overrides", () => {
      expect(
        formatCurrency(10, "USD", {
          locale: "en-US",
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        }),
      ).toBe("$10");
    });
  });

  describe("formatAssetAmount", () => {
    it("formats a non-ISO-4217 asset like XLM with grouping and up to 7 fraction digits", () => {
      expect(
        formatAssetAmount(2500, "XLM", { locale: "en-US" }),
      ).toBe("2,500 XLM");
      expect(
        formatAssetAmount(2500.1234567, "XLM", { locale: "en-US" }),
      ).toBe("2,500.1234567 XLM");
    });

    it("formats USDC amounts", () => {
      expect(formatAssetAmount(99.5, "USDC", { locale: "en-US" })).toBe(
        "99.5 USDC",
      );
    });

    it("respects a custom maximumFractionDigits", () => {
      expect(
        formatAssetAmount(2500.1234567, "XLM", {
          locale: "en-US",
          maximumFractionDigits: 2,
        }),
      ).toBe("2,500.12 XLM");
    });
  });

  describe("formatStroops", () => {
    it("converts stroops to XLM using the 10,000,000 stroop-per-XLM ratio", () => {
      expect(formatStroops("25000000000", "XLM", { locale: "en-US" })).toBe(
        "2,500 XLM",
      );
      expect(formatStroops("5000000000", "XLM", { locale: "en-US" })).toBe(
        "500 XLM",
      );
      expect(formatStroops("0", "XLM", { locale: "en-US" })).toBe("0 XLM");
    });

    it("defaults the asset code to XLM", () => {
      expect(formatStroops("10000000", undefined, { locale: "en-US" })).toBe(
        "1 XLM",
      );
    });

    it("exposes STROOPS_PER_XLM as 10,000,000", () => {
      expect(STROOPS_PER_XLM).toBe(10_000_000);
    });
  });

  describe("formatStroopsAmount", () => {
    it("returns a plain grouped number with no asset code suffix", () => {
      expect(formatStroopsAmount("25000000000", { locale: "en-US" })).toBe(
        "2,500",
      );
    });

    it("matches formatStroops's numeric portion for the same input", () => {
      const amount = formatStroopsAmount("5000000000", { locale: "en-US" });
      const withSuffix = formatStroops("5000000000", "XLM", {
        locale: "en-US",
      });
      expect(withSuffix).toBe(`${amount} XLM`);
    });

    it("supports fractional stroop amounts (e.g. 2.5 XLM progress display)", () => {
      expect(formatStroopsAmount("25000000", { locale: "en-US" })).toBe(
        "2.5",
      );
    });
  });

  describe("parseLocaleNumber", () => {
    it("parses a plain en-US formatted number", () => {
      expect(parseLocaleNumber("1,234.5", "en-US")).toBe(1234.5);
    });

    it("parses a de-DE formatted number (dot grouping, comma decimal)", () => {
      expect(parseLocaleNumber("1.234,5", "de-DE")).toBe(1234.5);
    });

    it("parses a fr-FR formatted number (space grouping, comma decimal)", () => {
      expect(parseLocaleNumber("1 234,5", "fr-FR")).toBe(1234.5);
    });

    it("parses a plain integer with no separators", () => {
      expect(parseLocaleNumber("500", "en-US")).toBe(500);
    });

    it("parses a negative number", () => {
      expect(parseLocaleNumber("-1,234.5", "en-US")).toBe(-1234.5);
    });

    it("returns NaN for an empty or whitespace-only string", () => {
      expect(Number.isNaN(parseLocaleNumber("", "en-US"))).toBe(true);
      expect(Number.isNaN(parseLocaleNumber("   ", "en-US"))).toBe(true);
    });

    it("returns NaN for input with no digits", () => {
      expect(Number.isNaN(parseLocaleNumber("abc", "en-US"))).toBe(true);
    });

    it("ignores a currency symbol mixed into the input", () => {
      expect(parseLocaleNumber("$1,234.50", "en-US")).toBe(1234.5);
    });

    it("round-trips values produced by formatNumber for a given locale", () => {
      for (const locale of ["en-US", "de-DE", "fr-FR"]) {
        const original = 987654.32;
        const formatted = formatNumber(original, {
          locale,
          maximumFractionDigits: 2,
        });
        expect(parseLocaleNumber(formatted, locale)).toBeCloseTo(
          original,
          2,
        );
      }
    });
  });

  describe("formatUsdc", () => {
    it("uses 7 decimals (10,000,000 stroops per USDC)", () => {
      expect(USDC_DECIMALS).toBe(7);
      expect(STROOPS_PER_USDC).toBe(BigInt(10_000_000));
    });

    it("formats stroops with locale grouping and a 2-digit minimum", () => {
      expect(formatUsdc("12345678900000", { locale: "en-US" })).toBe(
        "1,234,567.89",
      );
      expect(formatUsdc("10000000", { locale: "en-US" })).toBe("1.00");
      expect(formatUsdc("12345678900000", { locale: "de-DE" })).toBe(
        "1.234.567,89",
      );
    });

    it("keeps all 7 decimals by default", () => {
      expect(formatUsdc("1", { locale: "en-US" })).toBe("0.0000001");
      expect(formatUsdc(BigInt(12345678), { locale: "en-US" })).toBe("1.2345678");
    });

    it("truncates (never rounds up) past maximumFractionDigits", () => {
      expect(
        formatUsdc("19999999", { locale: "en-US", maximumFractionDigits: 2 }),
      ).toBe("1.99");
    });

    it("formats values far beyond Number.MAX_SAFE_INTEGER exactly", () => {
      expect(
        formatUsdc("123456789012345678901234567", {
          locale: "en-US",
          useGrouping: false,
        }),
      ).toBe("12345678901234567890.1234567");
    });

    it("handles negatives, the symbol suffix, and invalid input", () => {
      expect(formatUsdc(-BigInt(15000000), { locale: "en-US" })).toBe("-1.50");
      expect(formatUsdc("5000000", { locale: "en-US", withSymbol: true })).toBe(
        "0.50 USDC",
      );
      expect(formatUsdc("not-a-number", { locale: "en-US" })).toBe("0.00");
    });
  });

  describe("parseUsdc", () => {
    it("parses locale-formatted input into stroops", () => {
      expect(parseUsdc("1,234.5", "en-US")).toEqual({
        ok: true,
        stroops: BigInt(12345000000),
      });
      expect(parseUsdc("1.234,5", "de-DE")).toEqual({
        ok: true,
        stroops: BigInt(12345000000),
      });
      expect(parseUsdc("1\u202f234,5", "fr-FR")).toEqual({
        ok: true,
        stroops: BigInt(12345000000),
      });
      expect(parseUsdc(".5", "en-US")).toEqual({ ok: true, stroops: BigInt(5000000) });
      expect(parseUsdc("10 USDC", "en-US")).toEqual({
        ok: true,
        stroops: BigInt(100000000),
      });
    });

    it("rejects more than 7 decimals", () => {
      expect(parseUsdc("0.00000001", "en-US")).toEqual({
        ok: false,
        error: "too_many_decimals",
      });
    });

    it("rejects malformed grouping instead of guessing", () => {
      // In de-DE "." groups thousands, so "1.5" is not a valid number.
      expect(parseUsdc("1.5", "de-DE")).toEqual({ ok: false, error: "invalid" });
      expect(parseUsdc("12,34", "en-US")).toEqual({
        ok: false,
        error: "invalid",
      });
    });

    it("rejects empty, negative, and non-numeric input", () => {
      expect(parseUsdc("  ", "en-US")).toEqual({ ok: false, error: "empty" });
      expect(parseUsdc("-1", "en-US")).toEqual({ ok: false, error: "invalid" });
      expect(parseUsdc("abc", "en-US")).toEqual({ ok: false, error: "invalid" });
      expect(parseUsdc("1.2.3", "en-US")).toEqual({
        ok: false,
        error: "invalid",
      });
      expect(parseUsdc(".", "en-US")).toEqual({ ok: false, error: "invalid" });
    });

    it("round-trips stroops -> display -> stroops without precision loss", () => {
      const samples = [
        BigInt(0),
        BigInt(1),
        BigInt(9_999_999),
        BigInt(10_000_000),
        BigInt(12_345_678),
        BigInt(100_000_000_000_001),
        BigInt("1267650600228229401496703205383"),
      ];
      for (const locale of ["en-US", "de-DE", "fr-FR", "en-IN"]) {
        for (const stroops of samples) {
          const display = formatUsdc(stroops, { locale });
          expect(parseUsdc(display, locale)).toEqual({ ok: true, stroops });
        }
      }
    });
  });

  describe("validateUsdcAmount", () => {
    it("returns stroops for a valid amount", () => {
      expect(validateUsdcAmount("2.5", { locale: "en-US" })).toEqual({
        ok: true,
        stroops: BigInt(25000000),
      });
    });

    it("rejects zero by default", () => {
      expect(validateUsdcAmount("0", { locale: "en-US" })).toEqual({
        ok: false,
        error: "Amount must be greater than 0.",
      });
    });

    it("enforces min and max bounds", () => {
      expect(
        validateUsdcAmount("0.5", { locale: "en-US", min: BigInt(10_000_000) }),
      ).toEqual({ ok: false, error: "Minimum amount is 1 USDC." });
      expect(
        validateUsdcAmount("101", { locale: "en-US", max: BigInt(1_000_000_000) }),
      ).toEqual({ ok: false, error: "Maximum amount is 100 USDC." });
    });

    it("maps parse errors to user-facing messages", () => {
      expect(validateUsdcAmount("", { locale: "en-US" })).toEqual({
        ok: false,
        error: "Enter an amount.",
      });
      expect(validateUsdcAmount("1.123456789", { locale: "en-US" })).toEqual({
        ok: false,
        error: "USDC supports at most 7 decimal places.",
      });
    });
  });
});
