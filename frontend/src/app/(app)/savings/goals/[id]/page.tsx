"use client";

import { useEffect, useState, useCallback } from "react";
import { Target } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { useGoalClaim } from "@/hooks/useGoalClaim";
import ErrorRetry from "@/components/ui/ErrorRetry";
import { formatStroopsAmount } from "@/lib/currency";

interface Goal {
  on_chain_id: string;
  name: string;
  target_amount: string;
  current_amount: string;
  status: "active" | "reached" | "claimed";
}

type PageStatus = "loading" | "ready" | "not-found" | "error";

export default function GoalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [id, setId] = useState<string | null>(null);
  const [goal, setGoal] = useState<Goal | null>(null);
  const [status, setStatus] = useState<PageStatus>("loading");
  const [error, setError] = useState<Error | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const { status: claimStatus, error: claimError, claimGoal } = useGoalClaim();

  useEffect(() => {
    let cancelled = false;
    params.then(({ id: resolvedId }) => {
      if (!cancelled) setId(resolvedId);
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  const fetchGoal = useCallback(async () => {
    if (id === null) return;

    setStatus("loading");
    setError(null);

    try {
      const response = await apiFetch(`/api/goals/${id}`);

      if (response.status === 404) {
        setGoal(null);
        setStatus("not-found");
        return;
      }

      if (!response.ok) {
        throw new ApiError(
          `Failed to load goal: ${response.statusText}`,
          response.status,
        );
      }

      const data: Goal = await response.json();
      setGoal(data);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Unknown error occurred"));
      setStatus("error");
    }
  }, [id]);

  useEffect(() => {
    fetchGoal();
  }, [fetchGoal]);

  const handleConfirmClaim = async () => {
    if (!goal) return;
    const result = await claimGoal(goal.on_chain_id);
    if (result) {
      // Reflect the closed goal after a successful claim.
      setShowConfirm(false);
      setGoal({ ...goal, status: "claimed" });
    }
    // On failure, keep the confirm dialog open so the error message (shown
    // inside it) stays visible instead of silently reverting to the
    // pre-confirmation "Claim goal" button.
  };

  if (id === null || status === "loading") {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-muted">
            Loading goal...
          </div>
        </div>
      </div>
    );
  }

  if (status === "not-found") {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-border bg-card p-8 text-center">
            <h2 className="text-xl font-semibold text-foreground mb-2">
              Goal not found
            </h2>
            <p className="text-muted">
              This goal doesn&apos;t exist or may have been removed.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="mx-auto max-w-2xl">
          <ErrorRetry error={error} onRetry={fetchGoal} />
        </div>
      </div>
    );
  }

  if (!goal) {
    return null;
  }

  const canClaim = goal.status === "reached";
  const target = Number(goal.target_amount);
  const current = Number(goal.current_amount);
  const percentage = target > 0 ? Math.min(100, (current / target) * 100) : 0;

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Target className="h-8 w-8 text-brand" />
            <h1 className="text-3xl font-semibold text-foreground">{goal.name}</h1>
          </div>
          <span
            className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${
              goal.status === "claimed"
                ? "bg-muted/20 text-muted"
                : goal.status === "reached"
                  ? "bg-brand/10 text-brand"
                  : "bg-muted/10 text-foreground"
            }`}
          >
            {goal.status === "claimed"
              ? "Claimed"
              : goal.status === "reached"
                ? "Reached"
                : "In progress"}
          </span>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 mb-6">
          <p className="text-sm text-muted mb-1">Progress</p>
          <p className="text-2xl font-semibold text-foreground">
            {formatStroopsAmount(goal.current_amount)} / {formatStroopsAmount(goal.target_amount)} XLM
          </p>
          <div className="mt-3 h-2 w-full rounded-full bg-white/5">
            <div
              className="h-2 rounded-full bg-brand transition-[width] duration-300"
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">Claim</h2>

          {goal.status === "claimed" ? (
            <p className="text-muted">This goal has already been claimed.</p>
          ) : !canClaim ? (
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="w-full cursor-not-allowed rounded-xl bg-muted/20 px-4 py-2 text-sm font-medium text-muted"
            >
              Claim (available once target is reached)
            </button>
          ) : showConfirm ? (
            <div className="space-y-3">
              <p className="text-sm text-foreground">
                Claim {formatStroopsAmount(goal.current_amount)} XLM from this goal?
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleConfirmClaim}
                  disabled={claimStatus === "pending"}
                  className="flex-1 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50"
                >
                  {claimStatus === "pending" ? "Claiming..." : "Confirm claim"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowConfirm(false)}
                  disabled={claimStatus === "pending"}
                  className="flex-1 rounded-xl border border-border px-4 py-2 text-sm font-medium text-foreground"
                >
                  Cancel
                </button>
              </div>
              {claimStatus === "error" && (
                <p role="alert" className="text-sm text-red-400">
                  {claimError?.message ?? "Failed to claim goal."}
                </p>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowConfirm(true)}
              className="w-full rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90"
            >
              Claim goal
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
