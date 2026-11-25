"use client";

import type { GoalContributionSummary } from "@/lib/goalContributions";

export interface ContributorListProps {
  summary: GoalContributionSummary;
  /** Shows each contributor's remaining allowance when a per-user limit is set. */
  showAllowance?: boolean;
  currency?: string;
}

const formatAmount = (value: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);

export default function ContributorList({
  summary,
  showAllowance = false,
  currency = "USD",
}: ContributorListProps) {
  return (
    <section aria-labelledby="contributors-heading" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 id="contributors-heading" className="font-semibold">
          Contributors
        </h3>
        <p className="text-sm">
          {formatAmount(summary.total, currency)} of{" "}
          {formatAmount(summary.target, currency)} ({Math.round(summary.progressPercent)}%)
        </p>
      </div>
      {summary.contributors.length === 0 ? (
        <p className="text-sm opacity-70">No contributions yet.</p>
      ) : (
        <ul className="divide-y">
          {summary.contributors.map((c) => (
            <li key={c.address} className="flex justify-between gap-4 py-2 text-sm">
              <span className="truncate font-mono">{c.address}</span>
              <span className="whitespace-nowrap">
                {formatAmount(c.amount, currency)} ({c.percent.toFixed(1)}%)
                {showAllowance && c.remainingAllowance !== null && (
                  <span className="ml-2 opacity-70">
                    {formatAmount(c.remainingAllowance, currency)} left
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
