export interface SummaryCardSkeletonProps {
  className?: string;
}

/**
 * Placeholder shown in place of a savings summary card while its data
 * is being fetched.
 */
export default function SummaryCardSkeleton({
  className = "",
}: SummaryCardSkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-2xl border border-border bg-card p-6 ${className}`}
    >
      <div className="h-3 w-24 rounded bg-foreground/5" />
      <div className="mt-3 h-7 w-32 rounded bg-foreground/5" />
      <div className="mt-4 h-2 w-full rounded bg-foreground/5" />
    </div>
  );
}
