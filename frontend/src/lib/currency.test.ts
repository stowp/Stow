import { describe, it, expect } from "vitest";
import {
  formatNumber,
  formatCurrency,
  formatAssetAmount,
  formatStroops,
  formatStroopsAmount,
  parseLocaleNumber,
  STROOPS_PER_XLM,
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
});
