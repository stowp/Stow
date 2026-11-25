/**
 * Shared savings goal contributions (issue #633).
 *
 * Pure helpers for a goal that several contributors save into: total
 * progress, each contributor's share, and per-user contribution limits.
 */

export interface ContributorShare {
  address: string;
  amount: number;
  /** Share of the total contributed so far, 0–100. */
  percent: number;
  /** Room left under the per-user limit, or `null` when there is no limit. */
  remainingAllowance: number | null;
}

export interface GoalContributionSummary {
  total: number;
  target: number;
  /** Total progress towards the target, clamped to 0–100. */
  progressPercent: number;
  /** Contributors sorted by amount, largest first. */
  contributors: ContributorShare[];
}

export interface ContributionCheck {
  allowed: boolean;
  reason?: "invalid-amount" | "over-limit";
  /** How much this user may still add after this call, or `null` when unlimited. */
  remainingAllowance: number | null;
}

/**
 * Summarises contributions keyed by contributor address. Amounts that are
 * not finite or are negative are ignored. `perUserLimit` (optional) is used
 * to report how much room each contributor has left.
 */
export function summarizeGoalContributions(
  contributions: Readonly<Record<string, number>>,
  target: number,
  perUserLimit: number | null = null,
): GoalContributionSummary {
  const entries = Object.entries(contributions)
    .map(([address, amount]) => ({ address, amount: Number(amount) }))
    .filter((e) => Number.isFinite(e.amount) && e.amount > 0);

  const total = entries.reduce((sum, e) => sum + e.amount, 0);
  const progressPercent =
    target > 0 ? Math.min(100, Math.max(0, (total / target) * 100)) : 0;

  const contributors = entries
    .map<ContributorShare>((e) => ({
      address: e.address,
      amount: e.amount,
      percent: total > 0 ? (e.amount / total) * 100 : 0,
      remainingAllowance:
        perUserLimit === null ? null : Math.max(0, perUserLimit - e.amount),
    }))
    .sort((a, b) => b.amount - a.amount);

  return { total, target, progressPercent, contributors };
}

/**
 * Checks whether `amount` can be added by a contributor who has already put
 * in `currentAmount`, given an optional per-user cap.
 */
export function checkContribution(
  currentAmount: number,
  amount: number,
  perUserLimit: number | null = null,
): ContributionCheck {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { allowed: false, reason: "invalid-amount", remainingAllowance: null };
  }
  if (perUserLimit === null) {
    return { allowed: true, remainingAllowance: null };
  }
  const remaining = Math.max(0, perUserLimit - currentAmount);
  if (amount > remaining) {
    return { allowed: false, reason: "over-limit", remainingAllowance: remaining };
  }
  return { allowed: true, remainingAllowance: remaining - amount };
}
