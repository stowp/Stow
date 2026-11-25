import { useState, useCallback } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { enqueueOperation, isNetworkError, isOnline } from "@/lib/offline";
import { parseTopUpAmountToStroops } from "./useLockedTopUp";

export type WithdrawAmountError =
  | "required"
  | "invalid"
  | "too-small"
  | "too-precise"
  | "exceeds-balance";

/** Stellar amounts carry at most 7 fractional digits (1 stroop = 1e-7). */
const STROOP_DECIMALS = 7;

const AMOUNT_PATTERN = /^(\d+)(?:[.,](\d+))?$/;

/**
 * Client-side validation for a flexible-savings withdrawal. `balance` is the
 * account's current flexible balance in stroops; amounts above it are
 * blocked here, mirroring the vault contract's `withdraw`, which rejects
 * them with `InsufficientBalance`.
 */
export function validateWithdrawAmount(
  amount: string,
  balance: string,
): WithdrawAmountError | null {
  const trimmed = amount.trim();
  if (!trimmed) return "required";

  const match = AMOUNT_PATTERN.exec(trimmed);
  if (!match) return "invalid";
  if ((match[2] ?? "").length > STROOP_DECIMALS) return "too-precise";

  const stroops = parseTopUpAmountToStroops(trimmed);
  if (stroops === null) return "invalid";
  if (BigInt(stroops) <= BigInt(0)) return "too-small";
  if (BigInt(stroops) > BigInt(balance || "0")) return "exceeds-balance";

  return null;
}

export const WITHDRAW_AMOUNT_ERROR_MESSAGES: Record<WithdrawAmountError, string> = {
  required: "Enter an amount to withdraw.",
  invalid: "Enter a valid number, e.g. 25 or 25.5.",
  "too-small": "Amount must be greater than zero.",
  "too-precise": "Amounts can have at most 7 decimal places.",
  "exceeds-balance": "Amount exceeds your available balance.",
};

/** `queued`: the device was offline, so the withdrawal was saved to the
 * offline queue (`@/lib/offline`) and will be sent once reconnected. */
export type WithdrawStatus = "idle" | "pending" | "success" | "queued" | "error";

export interface WithdrawResult {
  owner: string;
  /** Flexible balance in stroops after the withdrawal. */
  balance: string;
}

export interface UseWithdrawReturn {
  status: WithdrawStatus;
  error: Error | null;
  isLoading: boolean;
  /**
   * Validates `amount` against `balance` (stroops), then withdraws it from
   * `owner`'s flexible savings. Resolves with the updated account on
   * success, or `null` on a validation/network failure (`status`/`error`
   * describe which).
   */
  withdraw: (
    owner: string,
    amount: string,
    balance: string,
  ) => Promise<WithdrawResult | null>;
  reset: () => void;
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Withdraws from flexible savings via `POST /api/savings/flexible/withdraw`
 * (mirrors the vault contract's `withdraw(owner, amount)`). The amount is
 * sent in stroops as a string, and each call carries a fresh
 * `Idempotency-Key` so a network retry of the same attempt can't
 * double-withdraw.
 */
export function useWithdraw(): UseWithdrawReturn {
  const [status, setStatus] = useState<WithdrawStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  const withdraw = useCallback(
    async (
      owner: string,
      amount: string,
      balance: string,
    ): Promise<WithdrawResult | null> => {
      const validation = validateWithdrawAmount(amount, balance);
      if (validation) {
        setError(new Error(WITHDRAW_AMOUNT_ERROR_MESSAGES[validation]));
        setStatus("error");
        return null;
      }

      setError(null);
      const stroops = parseTopUpAmountToStroops(amount) ?? "0";
      const idempotencyKey = newIdempotencyKey();

      // Offline: queue it to be replayed (same idempotency key) on reconnect.
      if (!isOnline()) {
        enqueueOperation({ type: "withdraw", account: owner, amount: stroops, idempotencyKey });
        setStatus("queued");
        return null;
      }

      setStatus("pending");

      try {
        const response = await apiFetch("/api/savings/flexible/withdraw", {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({
            owner,
            amount: stroops,
          }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to withdraw: ${response.statusText}`;
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

        const data: WithdrawResult = await response.json();
        setStatus("success");
        return data;
      } catch (err) {
        // The connection dropped mid-request: queue it rather than lose it.
        // Reusing the idempotency key makes the replay safe even if this
        // attempt actually reached the server.
        if (isNetworkError(err) && !isOnline()) {
          enqueueOperation({ type: "withdraw", account: owner, amount: stroops, idempotencyKey });
          setStatus("queued");
          return null;
        }
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
    withdraw,
    reset,
  };
}
