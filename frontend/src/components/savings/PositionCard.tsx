"use client";

export interface Position {
  id: string;
  amount: string;
  value: number;
  assetCode: string;
}

export interface PositionCardProps {
  position: Position;
  /** Formatted value string (using locale-aware formatYieldAmount) */
  formattedValue: string;
}

export default function PositionCard({
  position,
  formattedValue,
}: PositionCardProps) {
  return (
    <article
      className="rounded-lg border border-border bg-card p-4"
      aria-labelledby={`position-title-${position.id}`}
    >
      <header>
        <h3
          id={`position-title-${position.id}`}
          className="text-sm font-medium text-muted"
        >
          Position Value
        </h3>
      </header>

      <div className="mt-2">
        <p
          className="text-2xl font-bold"
          aria-label={`Position value: ${formattedValue}`}
        >
          {formattedValue}
        </p>
        <p className="mt-1 text-xs text-muted">
          {position.amount} {position.assetCode}
        </p>
      </div>
    </article>
  );
}
