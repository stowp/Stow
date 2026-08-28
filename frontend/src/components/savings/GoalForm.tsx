"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { useCreateGoal } from "@/hooks/useCreateGoal";

export interface GoalFormProps {
  /** Called with the newly created goal's on-chain id once creation succeeds. */
  onCreated: (goalId: string) => void;
}

const STROOPS_PER_XLM = 10_000_000;

/**
 * Converts a user-entered XLM amount (e.g. "12.5") into a whole-stroop
 * integer string suitable for the contract's `i128` target_amount, or
 * `null` if the input isn't a finite, strictly positive number. Values are
 * floored to the nearest stroop (Soroban amounts have no fractional
 * stroops) rather than rejected outright, since a user typing more than 7
 * decimal places is a precision mistake, not an invalid-amount error.
 */
function parseXlmToStroops(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const xlm = Number(trimmed);
  if (!Number.isFinite(xlm) || xlm <= 0) return null;

  return Math.floor(xlm * STROOPS_PER_XLM).toString();
}

export default function GoalForm({ onCreated }: GoalFormProps) {
  const [name, setName] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const { status, error, isLoading, createGoal } = useCreateGoal();

  const trimmedName = name.trim();
  const stroops = parseXlmToStroops(targetAmount);
  const canSubmit = trimmedName !== "" && stroops !== null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      setValidationError(
        targetAmount.trim() === ""
          ? "Enter a target amount."
          : "Target amount must be a positive number.",
      );
      return;
    }
    setValidationError(null);
    setShowConfirm(true);
  };

  const handleConfirmCreate = async () => {
    if (!canSubmit || stroops === null) return;

    const goal = await createGoal(trimmedName, stroops);
    if (goal) {
      onCreated(goal.on_chain_id);
    }
    // On failure, keep the confirm dialog open so the error message stays
    // visible instead of silently reverting to the pre-confirmation form.
  };

  if (showConfirm) {
    return (
      <div className="space-y-6">
        <div className="rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground mb-2">
            Confirm new goal
          </h2>
          <p className="text-sm text-muted mb-1">
            Name: <span className="text-foreground">{trimmedName}</span>
          </p>
          <p className="text-sm text-muted">
            Target:{" "}
            <span className="text-foreground">
              {Number(targetAmount).toLocaleString(undefined, {
                maximumFractionDigits: 7,
              })}{" "}
              XLM
            </span>
          </p>
        </div>

        {status === "error" && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-400"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error?.message ?? "Failed to create goal. Please try again."}
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleConfirmCreate}
            disabled={isLoading}
            className="flex-1 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? "Creating..." : "Confirm and create goal"}
          </button>
          <button
            type="button"
            onClick={() => setShowConfirm(false)}
            disabled={isLoading}
            className="flex-1 rounded-xl border border-border px-4 py-2 text-sm font-medium text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <div>
          <label
            htmlFor="goal-name"
            className="block text-sm font-medium text-foreground mb-2"
          >
            Goal name
          </label>
          <input
            id="goal-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. New laptop"
            className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand/50"
            required
          />
        </div>

        <div>
          <label
            htmlFor="goal-target-amount"
            className="block text-sm font-medium text-foreground mb-2"
          >
            Target amount (XLM)
          </label>
          <input
            id="goal-target-amount"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={targetAmount}
            onChange={(e) => setTargetAmount(e.target.value)}
            placeholder="e.g. 500"
            className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand/50"
            required
          />
        </div>
      </div>

      {validationError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-400"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          {validationError}
        </div>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full rounded-xl bg-brand/20 hover:bg-brand/30 border border-brand/40 px-6 py-3 text-sm font-medium text-brand transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-brand/50"
      >
        Create goal
      </button>
    </form>
  );
}
