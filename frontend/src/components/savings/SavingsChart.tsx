"use client";

import { useMemo, useState, useCallback } from "react";

export type TimeRange = "1M" | "3M" | "6M" | "1Y" | "ALL";

export interface BalanceDataPoint {
  date: Date;
  balance: number;
  type: "deposit" | "withdrawal";
}

export interface GoalTarget {
  name: string;
  amount: number;
  reached: boolean;
}

export interface SavingsChartProps {
  data: BalanceDataPoint[];
  goals?: GoalTarget[];
  timeRange: TimeRange;
  onTimeRangeChange?: (range: TimeRange) => void;
  height?: number;
}

const TIME_RANGE_DAYS: Record<TimeRange, number> = {
  "1M": 30,
  "3M": 90,
  "6M": 180,
  "1Y": 365,
  "ALL": Infinity,
};

export function SavingsChart({
  data,
  goals = [],
  timeRange,
  onTimeRangeChange,
  height = 300,
}: SavingsChartProps) {
  const [hoveredPoint, setHoveredPoint] = useState<BalanceDataPoint | null>(null);

  const filteredData = useMemo(() => {
    if (timeRange === "ALL") return data;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - TIME_RANGE_DAYS[timeRange]);
    return data.filter((d) => d.date >= cutoff);
  }, [data, timeRange]);

  const { minBalance, maxBalance, minDate, maxDate } = useMemo(() => {
    if (filteredData.length === 0) {
      return { minBalance: 0, maxBalance: 100, minDate: new Date(), maxDate: new Date() };
    }
    const balances = filteredData.map((d) => d.balance);
    const min = Math.min(...balances, 0);
    const max = Math.max(...balances, ...goals.map((g) => g.amount));
    const dates = filteredData.map((d) => d.date);
    return {
      minBalance: min,
      maxBalance: max * 1.1,
      minDate: new Date(Math.min(...dates.map((d) => d.getTime()))),
      maxDate: new Date(Math.max(...dates.map((d) => d.getTime()))),
    };
  }, [filteredData, goals]);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const formatBalance = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(value / 1_000_000);
  };

  const getX = useCallback(
    (date: Date) => {
      const total = maxDate.getTime() - minDate.getTime();
      const offset = date.getTime() - minDate.getTime();
      return total === 0 ? 0 : (offset / total) * 100;
    },
    [minDate, maxDate],
  );

  const getY = useCallback(
    (balance: number) => {
      const range = maxBalance - minBalance;
      return range === 0 ? 50 : ((maxBalance - balance) / range) * 100;
    },
    [minBalance, maxBalance],
  );

  const pathD = useMemo(() => {
    if (filteredData.length === 0) return "";
    const sorted = [...filteredData].sort((a, b) => a.date.getTime() - b.date.getTime());
    let d = `M ${getX(sorted[0].date)}% ${getY(sorted[0].balance)}`;
    for (let i = 1; i < sorted.length; i++) {
      d += ` L ${getX(sorted[i].date)}% ${getY(sorted[i].balance)}`;
    }
    return d;
  }, [filteredData, getX, getY]);

  return (
    <div
      className="savings-chart"
      role="img"
      aria-label={`Savings progress chart for ${timeRange} time range`}
      tabIndex={0}
    >
      {/* Time range selector */}
      <div
        className="time-range-selector"
        role="radiogroup"
        aria-label="Select time range"
        style={{ display: "flex", gap: "8px", marginBottom: "16px" }}
      >
        {(["1M", "3M", "6M", "1Y", "ALL"] as TimeRange[]).map((range) => (
          <button
            key={range}
            role="radio"
            aria-checked={timeRange === range}
            onClick={() => onTimeRangeChange?.(range)}
            style={{
              padding: "6px 12px",
              borderRadius: "4px",
              border: "none",
              background: timeRange === range ? "#6366f1" : "#e2e8f0",
              color: timeRange === range ? "#fff" : "#1a1a2e",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            {range}
          </button>
        ))}
      </div>

      {/* Chart area */}
      <div
        style={{ position: "relative", height: `${height}px`, width: "100%" }}
        onMouseLeave={() => setHoveredPoint(null)}
      >
        {/* Goal target lines */}
        {goals.map((goal, i) => (
          <div
            key={goal.name}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: `${getY(goal.amount)}%`,
              borderTop: `2px dashed ${goal.reached ? "#22c55e" : "#f59e0b"}`,
              opacity: 0.7,
            }}
            role="img"
            aria-label={`Goal target: ${goal.name} at ${formatBalance(goal.amount)}`}
          >
            <span
              style={{
                position: "absolute",
                right: 0,
                top: "-20px",
                fontSize: "11px",
                color: goal.reached ? "#22c55e" : "#f59e0b",
                background: "#fff",
                padding: "2px 4px",
              }}
            >
              {goal.name}
            </span>
          </div>
        ))}

        {/* Balance line */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ width: "100%", height: "100%", overflow: "visible" }}
        >
          <path
            d={pathD}
            fill="none"
            stroke="#6366f1"
            strokeWidth="0.5"
            vectorEffect="non-scaling-stroke"
          />
          {/* Deposit markers */}
          {filteredData
            .filter((d) => d.type === "deposit")
            .map((d, i) => (
              <circle
                key={`deposit-${i}`}
                cx={`${getX(d.date)}%`}
                cy={`${getY(d.balance)}%`}
                r="1"
                fill="#22c55e"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          {/* Withdrawal markers */}
          {filteredData
            .filter((d) => d.type === "withdrawal")
            .map((d, i) => (
              <circle
                key={`withdrawal-${i}`}
                cx={`${getX(d.date)}%`}
                cy={`${getY(d.balance)}%`}
                r="1"
                fill="#ef4444"
                vectorEffect="non-scaling-stroke"
              />
            ))}
        </svg>

        {/* Hover tooltip */}
        {hoveredPoint && (
          <div
            style={{
              position: "absolute",
              left: `${getX(hoveredPoint.date)}%`,
              top: `${getY(hoveredPoint.balance)}%`,
              transform: "translate(-50%, -100%)",
              background: "#1a1a2e",
              color: "#fff",
              padding: "8px 12px",
              borderRadius: "6px",
              fontSize: "12px",
              pointerEvents: "none",
              zIndex: 10,
            }}
          >
            <div>{formatDate(hoveredPoint.date)}</div>
            <div style={{ fontWeight: 600 }}>{formatBalance(hoveredPoint.balance)}</div>
            <div style={{ fontSize: "10px", opacity: 0.8 }}>
              {hoveredPoint.type === "deposit" ? "↓ Deposit" : "↑ Withdrawal"}
            </div>
          </div>
        )}

        {/* Interactive overlay */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            cursor: "crosshair",
          }}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const targetDate = new Date(
              minDate.getTime() + x * (maxDate.getTime() - minDate.getTime()),
            );
            const closest = filteredData.reduce((prev, curr) =>
              Math.abs(curr.date.getTime() - targetDate.getTime()) <
              Math.abs(prev.date.getTime() - targetDate.getTime())
                ? curr
                : prev,
            );
            setHoveredPoint(closest);
          }}
        />
      </div>

      {/* Legend */}
      <div
        style={{
          display: "flex",
          gap: "16px",
          marginTop: "12px",
          fontSize: "12px",
          color: "#64748b",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#22c55e" }} />
          Deposit
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#ef4444" }} />
          Withdrawal
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ width: "16px", height: "0", borderTop: "2px dashed #f59e0b" }} />
          Goal Target
        </span>
      </div>
    </div>
  );
}