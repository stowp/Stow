"use client";

import { useId, useMemo } from "react";
import type { CalculatorPoint } from "@/lib/savingsCalculator";
import { describeSavingsGrowth } from "@/lib/audioDescriptions";

export interface SavingsGrowthChartProps {
  /** Month-by-month projection, starting at month 0. */
  points: CalculatorPoint[];
  className?: string;
}

const WIDTH = 640;
const HEIGHT = 300;
const PAD = { top: 16, right: 16, bottom: 36, left: 64 } as const;
/** Long projections are thinned to roughly this many points. */
const MAX_PLOTTED_POINTS = 120;

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Picks evenly spaced points but always keeps the first and last. */
function thin(points: CalculatorPoint[]): CalculatorPoint[] {
  if (points.length <= MAX_PLOTTED_POINTS) return points;
  const step = Math.ceil((points.length - 1) / (MAX_PLOTTED_POINTS - 1));
  const thinned = points.filter((_, index) => index % step === 0);
  const last = points[points.length - 1];
  if (thinned[thinned.length - 1] !== last) thinned.push(last);
  return thinned;
}

/** "Nice" axis maximum so tick labels land on round numbers. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const scaled = value / magnitude;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * magnitude;
}

function formatMonth(month: number): string {
  if (month % 12 === 0) return `${month / 12}y`;
  return `${month}m`;
}

/**
 * Stacked area chart of a projected balance, split into the principal the
 * user puts in and the interest it earns. Drawn as plain SVG so it adds no
 * charting dependency; the yearly table next to it carries the exact values.
 */
export default function SavingsGrowthChart({
  points,
  className = "",
}: SavingsGrowthChartProps) {
  const titleId = useId();
  const descId = useId();

  const chart = useMemo(() => {
    const plotted = thin(points);
    const last = points[points.length - 1];
    const lastMonth = last ? Math.max(last.month, 1) : 1;
    const top = niceMax(Math.max(...points.map(p => p.balance), 0));
    const plotWidth = WIDTH - PAD.left - PAD.right;
    const plotHeight = HEIGHT - PAD.top - PAD.bottom;

    const x = (month: number) => PAD.left + (month / lastMonth) * plotWidth;
    const y = (value: number) => PAD.top + plotHeight - (value / top) * plotHeight;
    const baseline = y(0);

    const line = (value: (p: CalculatorPoint) => number) =>
      plotted.map(p => `${x(p.month).toFixed(2)},${y(value(p)).toFixed(2)}`);

    const principalLine = line(p => p.principal);
    const balanceLine = line(p => p.balance);
    const firstX = x(plotted[0]?.month ?? 0).toFixed(2);
    const lastX = x(plotted[plotted.length - 1]?.month ?? 0).toFixed(2);

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(fraction => ({
      value: top * fraction,
      y: y(top * fraction),
    }));

    const xTickCount = Math.min(6, lastMonth);
    const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) => {
      const month = Math.round((lastMonth * i) / xTickCount);
      return { month, x: x(month) };
    }).filter((tick, i, all) => i === 0 || tick.month !== all[i - 1].month);

    return {
      principalArea: `M${firstX},${baseline} L${principalLine.join(" L")} L${lastX},${baseline} Z`,
      interestArea: `M${balanceLine.join(" L")} L${[...principalLine].reverse().join(" L")} Z`,
      balanceStroke: `M${balanceLine.join(" L")}`,
      yTicks,
      xTicks,
      baseline,
      plotRight: WIDTH - PAD.right,
    };
  }, [points]);

  const summary = describeSavingsGrowth(points);

  return (
    <figure className={className}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="h-auto w-full"
      >
        <title id={titleId}>Projected savings growth</title>
        <desc id={descId}>{summary}</desc>

        {chart.yTicks.map(tick => (
          <g key={tick.value}>
            <line
              x1={PAD.left}
              x2={chart.plotRight}
              y1={tick.y}
              y2={tick.y}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={tick.y}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--muted)"
            >
              {compact.format(tick.value)}
            </text>
          </g>
        ))}

        {chart.xTicks.map(tick => (
          <text
            key={tick.month}
            x={tick.x}
            y={chart.baseline + 20}
            textAnchor="middle"
            fontSize={11}
            fill="var(--muted)"
          >
            {formatMonth(tick.month)}
          </text>
        ))}

        <path d={chart.principalArea} fill="var(--brand-2)" fillOpacity={0.45} />
        <path d={chart.interestArea} fill="var(--brand)" fillOpacity={0.55} />
        <path
          d={chart.balanceStroke}
          fill="none"
          stroke="var(--brand)"
          strokeWidth={2}
        />
      </svg>

      <figcaption className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: "var(--brand-2)", opacity: 0.7 }}
          />
          Principal
        </span>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: "var(--brand)", opacity: 0.8 }}
          />
          Interest earned
        </span>
      </figcaption>
    </figure>
  );
}
