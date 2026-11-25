"use client";

import { useId, useState } from "react";
import { formatStroops } from "@/lib/currency";
import type { SavingsSummary } from "@/hooks/useSavingsSummary";
import { describePortfolioAllocation } from "@/lib/audioDescriptions";

interface PortfolioAllocationChartProps {
  summary: SavingsSummary | null;
  isLoading: boolean;
}

const CATEGORY_STYLES: Record<string, { label: string; color: string; swatch: string }> = {
  flexible: { label: "Flexible savings", color: "text-teal-500", swatch: "bg-teal-500" },
  goals: { label: "Savings goals", color: "text-amber-500", swatch: "bg-amber-500" },
};

const CENTER = 100;
const RADIUS = 88;

function pointAt(angle: number) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: CENTER + RADIUS * Math.cos(radians),
    y: CENTER + RADIUS * Math.sin(radians),
  };
}

function slicePath(startAngle: number, endAngle: number) {
  const start = pointAt(startAngle);
  const isFullCircle = endAngle - startAngle >= 359.999;

  if (isFullCircle) {
    const opposite = pointAt(startAngle + 180);
    return `M ${CENTER} ${CENTER} L ${start.x} ${start.y} A ${RADIUS} ${RADIUS} 0 1 1 ${opposite.x} ${opposite.y} A ${RADIUS} ${RADIUS} 0 1 1 ${start.x} ${start.y} Z`;
  }

  const end = pointAt(endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${CENTER} ${CENTER} L ${start.x} ${start.y} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

function parseStroops(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export default function PortfolioAllocationChart({
  summary,
  isLoading,
}: PortfolioAllocationChartProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [activeProduct, setActiveProduct] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div
        aria-label="Loading portfolio allocation"
        className="mt-8 h-64 animate-pulse rounded-lg border border-border bg-card"
        data-testid="portfolio-allocation-loading"
      />
    );
  }

  const products = summary?.products ?? [];
  const total = products.reduce((sum, product) => sum + parseStroops(product.total), 0n);
  const allocations = products.map((product, index) => {
    const value = parseStroops(product.total);
    const ratio = total > 0n && value > 0n
      ? Number((value * 1_000_000n) / total) / 1_000_000
      : 0;
    const style = CATEGORY_STYLES[product.product] ?? {
      label: product.product,
      color: index % 2 === 0 ? "text-sky-500" : "text-rose-500",
      swatch: index % 2 === 0 ? "bg-sky-500" : "bg-rose-500",
    };

    return {
      ...product,
      ...style,
      value,
      ratio,
      percent: ratio * 100,
    };
  });

  let nextAngle = -90;
  const slices = allocations
    .filter((allocation) => allocation.value > 0n)
    .map((allocation) => {
      const startAngle = nextAngle;
      nextAngle += allocation.ratio * 360;
      return { ...allocation, startAngle, endAngle: nextAngle };
    });

  const activeAllocation = allocations.find(
    (allocation) => allocation.product === (activeProduct ?? selectedProduct),
  );

  const toggleProduct = (product: string) => {
    setSelectedProduct((current) => (current === product ? null : product));
  };

  return (
    <section
      aria-labelledby="portfolio-allocation-heading"
      className="mt-8 rounded-lg border border-border bg-card p-5 sm:p-6"
      data-testid="portfolio-allocation"
    >
      <h2
        id="portfolio-allocation-heading"
        className="text-base font-semibold text-foreground"
      >
        Portfolio allocation
      </h2>

      {total <= 0n ? (
        <div className="mt-5 flex flex-col items-center gap-3 py-4 text-center">
          <div
            role="status"
            className="flex h-48 w-48 items-center justify-center rounded-full border-[18px] border-border px-6 text-sm text-muted"
          >
            No savings allocated yet
          </div>
        </div>
      ) : (
        <div className="mt-5 flex flex-col items-center gap-6 sm:flex-row sm:items-center">
          <svg
            role="group"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            viewBox="0 0 200 200"
            className="h-48 w-48 shrink-0 overflow-visible"
          >
            <title id={titleId}>Savings allocation by category</title>
            <desc id={descriptionId}>
              {describePortfolioAllocation(
                `${formatStroops(total.toString())} XLM`,
                allocations.map((allocation) => ({
                  label: allocation.label,
                  amount: `${formatStroops(allocation.total)} XLM`,
                  percent: allocation.percent,
                })),
              )}
            </desc>
            {slices.map((slice) => {
              const isActive = activeProduct === slice.product;
              const amount = formatStroops(slice.total);
              const percent = `${slice.percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
              const tooltip = `${slice.label}: ${amount} (${percent})`;

              return (
                <path
                  key={slice.product}
                  d={slicePath(slice.startAngle, slice.endAngle)}
                  role="button"
                  tabIndex={0}
                  aria-label={tooltip}
                  aria-pressed={selectedProduct === slice.product}
                  className={`${slice.color} cursor-pointer transition-opacity focus:outline-none focus:opacity-80 ${isActive ? "opacity-80" : "opacity-100"}`}
                  data-testid={`portfolio-allocation-slice-${slice.product}`}
                  fill="currentColor"
                  stroke="var(--background)"
                  strokeWidth="2"
                  onMouseEnter={() => setActiveProduct(slice.product)}
                  onMouseLeave={() => setActiveProduct(null)}
                  onFocus={() => setActiveProduct(slice.product)}
                  onBlur={() => setActiveProduct(null)}
                  onClick={() => toggleProduct(slice.product)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleProduct(slice.product);
                    }
                  }}
                >
                  <title>{tooltip}</title>
                </path>
              );
            })}
          </svg>

          <div className="min-w-0 flex-1">
            <div
              role="status"
              aria-live="polite"
              className="mb-3 min-h-10 rounded-md border border-border bg-background-elevated px-3 py-2 text-sm text-foreground"
              data-testid="portfolio-allocation-tooltip"
            >
              {activeAllocation
                ? `${activeAllocation.label}: ${formatStroops(activeAllocation.total)} (${activeAllocation.percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%)`
                : "Savings by category"}
            </div>
            <ul className="space-y-1">
              {allocations.map((allocation) => (
                <li key={allocation.product}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-background-elevated focus:outline-none focus:ring-2 focus:ring-brand/50"
                    aria-pressed={selectedProduct === allocation.product}
                    onMouseEnter={() => setActiveProduct(allocation.product)}
                    onMouseLeave={() => setActiveProduct(null)}
                    onFocus={() => setActiveProduct(allocation.product)}
                    onBlur={() => setActiveProduct(null)}
                    onClick={() => toggleProduct(allocation.product)}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-3 w-3 shrink-0 rounded-sm ${allocation.swatch}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {allocation.label}
                    </span>
                    <span className="text-sm font-medium tabular-nums text-foreground">
                      {formatStroops(allocation.total)}
                    </span>
                    <span className="w-12 text-right text-xs tabular-nums text-muted">
                      {allocation.percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}