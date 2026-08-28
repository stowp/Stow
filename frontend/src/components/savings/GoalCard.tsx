import ProgressRing from "./ProgressRing";
import { formatStroopsAmount } from "@/lib/currency";

export interface GoalCardGoal {
  on_chain_id: string;
  name: string;
  target_amount: string;
  current_amount: string;
  status: "active" | "reached" | "claimed";
}

export interface GoalCardProps {
  goal: GoalCardGoal;
  onContribute?: (goalId: string) => void;
  className?: string;
}

/**
 * Visualizes a single savings goal's progress toward its target, with a
 * contribute action for goals still in progress. Reached/claimed goals are
 * shown distinctly and don't offer a contribute action, since contributing
 * past a goal's target isn't a supported flow.
 */
export default function GoalCard({
  goal,
  onContribute,
  className = "",
}: GoalCardProps) {
  const target = Number(goal.target_amount);
  const current = Number(goal.current_amount);
  const percentage = target > 0 ? Math.min(100, (current / target) * 100) : 0;
  const isReached = goal.status === "reached" || goal.status === "claimed";

  return (
    <div
      data-testid="goal-card"
      className={`rounded-2xl border border-border bg-card p-6 ${className}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground">{goal.name}</h3>
          <p className="mt-1 text-sm text-muted">
            {formatStroopsAmount(goal.current_amount)} / {formatStroopsAmount(goal.target_amount)} XLM
          </p>
        </div>
        <ProgressRing percentage={percentage} label={`${goal.name} progress`} size={72} />
      </div>

      <div className="mt-4">
        {goal.status === "claimed" ? (
          <span
            data-testid="goal-status-badge"
            className="inline-block rounded-full bg-muted/20 px-3 py-1 text-xs font-medium text-muted"
          >
            Claimed
          </span>
        ) : isReached ? (
          <span
            data-testid="goal-status-badge"
            className="inline-block rounded-full bg-brand/10 px-3 py-1 text-xs font-medium text-brand"
          >
            Reached
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onContribute?.(goal.on_chain_id)}
            className="w-full rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90"
          >
            Contribute
          </button>
        )}
      </div>
    </div>
  );
}
