"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { formatStroops } from "@/lib/currency";
import {
  useWithdraw,
  validateWithdrawAmount,
  WITHDRAW_AMOUNT_ERROR_MESSAGES,
  type WithdrawAmountError,
} from "@/hooks/useWithdraw";

export interface WithdrawModalProps {
  open: boolean;
  onClose: () => void;
  /** Stellar account the withdrawal is made from (and paid back to). */
  account: string;
  /** Current flexible balance in stroops; withdrawals are capped at this. */
  balance: string;
  /** Called with the new flexible balance (stroops) once a withdrawal succeeds. */
  onWithdrawn?: (newBalance: string) => void;
}

/**
 * Converts a stroop string into a plain decimal string ("125000000" ->
 * "12.5") using string arithmetic only, so "Max" fills the exact balance
 * without float rounding.
 */
function stroopsToDecimal(stroops: string): string {
  const digits = (stroops || "0").replace(/^0+(?=\d)/, "").padStart(8, "0");
  const whole = digits.slice(0, -7).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-7).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Modal for withdrawing from flexible savings. Caps the amount at the
 * current balance, asks for confirmation, then shows
 * submit/pending/success/error states and disables double-submit.
 */
export default function WithdrawModal({
  open,
  onClose,
  account,
  balance,
  onWithdrawn,
}: WithdrawModalProps) {
  const [amount, setAmount] = useState("");
  const [validationError, setValidationError] =
    useState<WithdrawAmountError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [newBalance, setNewBalance] = useState<string | null>(null);
  const { status, error, isLoading, withdraw, reset } = useWithdraw();
  const dialogRef = useRef<HTMLDivElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);

  const isSuccess = status === "success" && newBalance !== null;

  useEffect(() => {
    if (!open) return;

    setAmount("");
    setValidationError(null);
    setConfirming(false);
    setNewBalance(null);
    reset();
    amountInputRef.current?.focus();

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusableElements =
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
      if (!focusableElements || focusableElements.length === 0) return;

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleEscape);
    document.addEventListener("keydown", handleTab);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("keydown", handleTab);
      document.body.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);

  if (!open) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const validation = validateWithdrawAmount(amount, balance);
    setValidationError(validation);
    if (validation) return;
    reset();
    setConfirming(true);
  };

  const handleConfirm = async () => {
    if (isLoading) return; // guards against double-submit
    const result = await withdraw(account, amount, balance);
    if (result) {
      setNewBalance(result.balance);
      onWithdrawn?.(result.balance);
    }
    // On failure, stay on the confirmation step so the error stays visible.
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="withdraw-modal-title"
    >
      <div
        ref={dialogRef}
        className="relative w-full max-w-md rounded-2xl border border-border bg-background-elevated p-6 shadow-2xl mx-4"
        role="document"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute right-4 top-4 rounded-lg p-1 text-muted hover:bg-card hover:text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-brand/50"
        >
          <X className="h-5 w-5" />
        </button>

        <h2
          id="withdraw-modal-title"
          className="text-xl font-semibold text-foreground mb-1"
        >
          Withdraw from flexible savings
        </h2>

        {isSuccess ? (
          <div className="mt-6 flex flex-col items-center text-center">
            <CheckCircle2
              className="h-12 w-12 text-brand mb-4"
              aria-hidden="true"
            />
            <p className="text-foreground font-medium mb-2">
              Withdrawal complete
            </p>
            <p className="text-sm text-muted mb-6">
              New balance:{" "}
              <span data-testid="withdraw-new-balance" className="text-foreground">
                {formatStroops(newBalance ?? "0")}
              </span>
            </p>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-xl bg-brand px-4 py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-brand/90"
            >
              Done
            </button>
          </div>
        ) : confirming ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-muted">
              You&apos;re about to withdraw{" "}
              <span className="font-medium text-foreground">
                {Number(amount.replace(",", ".")).toLocaleString(undefined, {
                  maximumFractionDigits: 7,
                })}{" "}
                XLM
              </span>{" "}
              from your flexible savings to your wallet.
            </p>

            {status === "queued" && (
              <div
                role="status"
                className="rounded-xl border border-yellow-400/30 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-500"
              >
                You&apos;re offline. This withdrawal has been queued and will be
                sent automatically when you reconnect.
              </div>
            )}

            {status === "error" && (
              <div
                role="alert"
                className="flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-400"
              >
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error?.message ?? "Failed to withdraw. Please try again."}
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={isLoading}
                className="flex-1 rounded-xl border border-border bg-card hover:bg-card/70 px-4 py-2.5 text-sm font-medium text-foreground transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand/50"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={isLoading}
                className="flex-1 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-brand/50"
              >
                {isLoading ? "Withdrawing..." : "Confirm withdrawal"}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4" noValidate>
            <p className="text-sm text-muted">
              Available balance:{" "}
              <span data-testid="withdraw-available-balance" className="text-foreground">
                {formatStroops(balance)}
              </span>
            </p>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <label
                  htmlFor="withdraw-amount"
                  className="block text-sm font-medium text-foreground"
                >
                  Amount (XLM)
                </label>
                <button
                  type="button"
                  onClick={() => setAmount(stroopsToDecimal(balance))}
                  className="text-xs font-medium text-brand hover:underline focus:outline-none focus:ring-2 focus:ring-brand/50 rounded"
                >
                  Max
                </button>
              </div>
              <input
                ref={amountInputRef}
                id="withdraw-amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setValidationError(null);
                }}
                placeholder="0.00"
                className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand/50 disabled:opacity-50"
                aria-invalid={validationError !== null}
                aria-describedby={
                  validationError ? "withdraw-amount-error" : undefined
                }
              />
              {validationError && (
                <p
                  id="withdraw-amount-error"
                  role="alert"
                  className="mt-2 text-sm text-red-400"
                >
                  {WITHDRAW_AMOUNT_ERROR_MESSAGES[validationError]}
                </p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-xl border border-border bg-card hover:bg-card/70 px-4 py-2.5 text-sm font-medium text-foreground transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand/50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 rounded-xl bg-brand/20 hover:bg-brand/30 border border-brand/40 px-4 py-2.5 text-sm font-medium text-brand transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-brand/50"
              >
                Withdraw
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
