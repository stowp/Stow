"use client";

import React, { useId, useState } from "react";
import {
  USDC_DECIMALS,
  formatUsdc,
  getLocaleSeparators,
  parseUsdc,
  validateUsdcAmount,
} from "@/lib/currency";

export interface AmountInputProps {
  /** Raw text as typed by the user (controlled). */
  value: string;
  /**
   * Called on every accepted edit with the raw text and the parsed stroop
   * amount — `null` while the text is empty or not a valid amount.
   */
  onChange: (value: string, stroops: bigint | null) => void;
  label?: string;
  /** BCP 47 locale for separators and display. Defaults to the runtime locale. */
  locale?: string;
  /** Smallest accepted amount, in stroops. Defaults to 1 (i.e. > 0). */
  min?: bigint;
  /** Largest accepted amount, in stroops — e.g. the available balance. Enables the "Max" button. */
  max?: bigint;
  /** External error (e.g. from the server); shown in place of validation errors. */
  error?: string;
  /** Helper text under the input, hidden while an error is shown. */
  hint?: string;
  id?: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
}

/**
 * Text input for USDC amounts. Accepts the locale's own decimal mark and
 * group separator, never allows more than 7 fraction digits, validates
 * range, and normalizes the display on blur. Amounts are reported in
 * stroops as a `bigint`, so nothing is lost to floating point.
 */
export function AmountInput({
  value,
  onChange,
  label = "Amount",
  locale,
  min,
  max,
  error,
  hint,
  id,
  name,
  placeholder = "0.00",
  disabled = false,
  required = false,
  className = "",
}: AmountInputProps) {
  const generatedId = useId();
  const inputId = id ?? `amount-${generatedId}`;
  const messageId = `${inputId}-message`;
  const [touched, setTouched] = useState(false);

  const { group, decimal } = getLocaleSeparators(locale);
  // Validation errors appear only after the first blur (or "Max"), so the
  // field doesn't shout at the user while they're still typing.
  let validationError: string | undefined;
  if (touched) {
    const result = validateUsdcAmount(value, { locale, min, max });
    if (!result.ok) validationError = result.error;
  }
  const shownError = error ?? validationError;

  function stroopsFor(text: string): bigint | null {
    const result = validateUsdcAmount(text, { locale, min, max });
    return result.ok ? result.stroops : null;
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;

    // Only digits, whitespace and the locale's own separators may be typed.
    for (const char of next) {
      if (!/[\d\s]/.test(char) && char !== group && char !== decimal) return;
    }
    // At most one decimal mark and never more than USDC_DECIMALS after it.
    const decimalParts = next.split(decimal);
    if (decimalParts.length > 2) return;
    if (decimalParts.length === 2 && decimalParts[1].length > USDC_DECIMALS) {
      return;
    }

    onChange(next, stroopsFor(next));
  }

  function handleBlur() {
    setTouched(true);
    const result = parseUsdc(value, locale);
    if (!result.ok) return;
    const normalized = formatUsdc(result.stroops, {
      locale,
      minimumFractionDigits: 0,
    });
    if (normalized !== value) onChange(normalized, stroopsFor(normalized));
  }

  function handleMax() {
    if (max === undefined) return;
    const formatted = formatUsdc(max, { locale, minimumFractionDigits: 0 });
    setTouched(true);
    onChange(formatted, stroopsFor(formatted));
  }

  return (
    <div className={className}>
      <label
        htmlFor={inputId}
        className="mb-2 block text-sm font-medium text-foreground"
      >
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          name={name}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={handleChange}
          onBlur={handleBlur}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={shownError || hint ? messageId : undefined}
          className={`w-full rounded-xl border bg-background py-3 pl-4 pr-28 text-foreground placeholder:text-muted focus:outline-none focus:ring-2 ${
            shownError
              ? "border-red-500 focus:ring-red-500/50"
              : "border-border focus:ring-brand/50"
          }`}
        />
        <div className="absolute inset-y-0 right-3 flex items-center gap-2">
          {max !== undefined && (
            <button
              type="button"
              onClick={handleMax}
              disabled={disabled}
              className="rounded-md px-2 py-1 text-xs font-semibold text-brand hover:bg-brand/10 disabled:opacity-50"
            >
              Max
            </button>
          )}
          <span className="text-sm text-muted" aria-hidden="true">
            USDC
          </span>
        </div>
      </div>
      {shownError ? (
        <p id={messageId} role="alert" className="mt-2 text-sm text-red-500">
          {shownError}
        </p>
      ) : hint ? (
        <p id={messageId} className="mt-2 text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export default AmountInput;
