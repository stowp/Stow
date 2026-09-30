import { useState, useCallback } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import type { LockedPlan } from "./useLockedPlanDetail";

export type TopUpAmountError =
  | "required"
  | "invalid"
  | "too-small"
  | "too-precise";

/** Stellar amounts carry at most 7 fractional digits (1 stroop = 1e-7). */
const STROOP_DECIMALS = 7;

const AMOUNT_PATTERN = /^(\d+)(?:[.,](\d+))?$/;

/**
 * Converts a user-typed decimal amount (e.g. "12.5" or "12,5") into an
 * integer stroop string ("125000000") using string arithmetic only, so large
 * amounts never lose precision through a JS `number`.
 *
 * Accepts either "." or "," as the decimal mark (no grouping separators) so
 * locales that write "12,5" work. Returns `null` when the input isn't a
 * plain non-negative decimal or has more than 7 fractional digits.
 */
export function parseTopUpAmountToStroops(amount: string): string | null {
  const match = AMOUNT_PATTERN.exec(amount.trim());
  if (!match) return null;

  const [, whole, fraction = ""] = match;
  if (fraction.length > STROOP_DECIMALS) return null;

  const stroops = `${whole}${fraction.padEnd(STROOP_DECIMALS, "0")}`.replace(
    /^0+(?=\d)/,
    "",
  );
  return stroops;
}

/**
 * Client-side validation for a locked-plan top-up amount. The contract
 * (`savings-vault::locked_top_up`) rejects non-positive amounts itself; this
 * gives the user immediate feedback before anything is signed or sent.
 */
export function validateTopUpAmount(amount: string): TopUpAmountError | null {
  const trimmed = amount.trim();
  if (!trimmed) return "required";

  const match = AMOUNT_PATTERN.exec(trimmed);
  if (!match) return "invalid";
  if ((match[2] ?? "").length > STROOP_DECIMALS) return "too-precise";

  const stroops = parseTopUpAmountToStroops(trimmed);
  if (stroops === null) return "invalid";
  if (BigInt(stroops) <= BigInt(0)) return "too-small";

  return null;
}

export const TOP_UP_AMOUNT_ERROR_MESSAGES: Record<TopUpAmountError, string> = {
  required: "Enter an amount to add.",
  invalid: "Enter a valid number, e.g. 25 or 25.5.",
  "too-small": "Amount must be greater than zero.",
  "too-precise": "Amounts can have at most 7 decimal places.",
};

export type LockedTopUpStatus = "idle" | "pending" | "success" | "error";

export interface UseLockedTopUpReturn {
  status: LockedTopUpStatus;
  error: Error | null;
  isLoading: boolean;
  /**
   * Validates `amount`, then tops up `planId` for `owner`. Resolves with the
   * updated plan on success, or `null` on a validation/network failure
   * (`status`/`error` describe which). The plan's `unlock_at` is never sent
   * — a top-up only ever adds to the balance.
   */
  topUp: (
    planId: string,
    owner: string,
    amount: string,
  ) => Promise<LockedPlan | null>;
  reset: () => void;
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Adds funds to an existing locked plan via
 * `POST /api/savings/locked/:id/top-up` (mirrors the vault contract's
 * `locked_top_up(owner, plan_id, amount)`). The amount is sent in stroops as
 * a string. Each call carries a fresh `Idempotency-Key`, so a network retry
 * of the same attempt can't double-deposit.
 */
export function useLockedTopUp(): UseLockedTopUpReturn {
  const [status, setStatus] = useState<LockedTopUpStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  const topUp = useCallback(
    async (
      planId: string,
      owner: string,
      amount: string,
    ): Promise<LockedPlan | null> => {
      const validation = validateTopUpAmount(amount);
      if (validation) {
        setError(new Error(TOP_UP_AMOUNT_ERROR_MESSAGES[validation]));
        setStatus("error");
        return null;
      }

      setStatus("pending");
      setError(null);

      try {
        const response = await apiFetch(
          `/api/savings/locked/${encodeURIComponent(planId)}/top-up`,
          {
            method: "POST",
            headers: { "Idempotency-Key": newIdempotencyKey() },
            body: JSON.stringify({
              owner,
              amount: parseTopUpAmountToStroops(amount),
            }),
          },
        );

        if (!response.ok) {
          let errorMessage = `Failed to top up plan: ${response.statusText}`;
          try {
            const errorData = await response.json();
            if (errorData.message) {
              errorMessage = errorData.message;
            }
          } catch {
            // Response body is not JSON, use default message
          }
          throw new ApiError(errorMessage, response.status);
        }

        const data: LockedPlan = await response.json();
        setStatus("success");
        return data;
      } catch (err) {
        setError(
          err instanceof Error ? err : new Error("Unknown error occurred"),
        );
        setStatus("error");
        return null;
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return {
    status,
    error,
    isLoading: status === "pending",
    topUp,
    reset,
  };
}
