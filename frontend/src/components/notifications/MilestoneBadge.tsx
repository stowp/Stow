"use client";

import { MILESTONES, type MilestoneType } from "@/context/MilestoneProvider";

interface MilestoneBadgeProps {
  /** The milestone type to display */
  milestoneType: MilestoneType;
  /** Whether the badge is earned */
  earned: boolean;
  /** Size variant */
  size?: "sm" | "md" | "lg";
  /** Show label text */
  showLabel?: boolean;
  /** Click handler for badge details */
  onClick?: () => void;
}

const tierColors = {
  bronze: "bg-amber-700/20 border-amber-700 text-amber-400",
  silver: "bg-slate-300/20 border-slate-300 text-slate-300",
  gold: "bg-yellow-500/20 border-yellow-500 text-yellow-400",
  platinum: "bg-cyan-400/20 border-cyan-400 text-cyan-300",
};

const sizeClasses = {
  sm: "h-8 w-8 text-sm",
  md: "h-12 w-12 text-xl",
  lg: "h-16 w-16 text-2xl",
};

/**
 * Badge component displaying a milestone achievement.
 * Shows earned milestones with their icon and optional label.
 */
export default function MilestoneBadge({
  milestoneType,
  earned,
  size = "md",
  showLabel = false,
  onClick,
}: MilestoneBadgeProps) {
  const milestone = MILESTONES[milestoneType];

  if (!milestone) return null;

  const Component = onClick ? "button" : "span";

  return (
    <Component
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-xl border transition-all ${
        earned
          ? `${tierColors[milestone.tier]} ${sizeClasses[size]} cursor-pointer hover:scale-105`
          : "border-border bg-card/50 text-muted/50 grayscale"
      } ${onClick ? "focus:outline-none focus:ring-2 focus:ring-brand/50" : ""}`}
      title={earned ? milestone.title : "Not yet earned"}
      aria-label={`${milestone.title}: ${earned ? "Earned" : "Not earned"}`}
    >
      <span aria-hidden="true">{milestone.icon}</span>
      {showLabel && <span className="text-sm font-medium">{milestone.title}</span>
    </Component>
  );
}

/**
 * Display a grid of milestone badges
 */
interface MilestoneGridProps {
  /** Array of milestone types to display */
  milestoneTypes: MilestoneType[];
  /** Function to check if milestone is earned */
  isEarned: (type: MilestoneType) => boolean;
  /** Size of badges */
  size?: "sm" | "md" | "lg";
  /** Show labels */
  showLabels?: boolean;
}

export function MilestoneGrid({
  milestoneTypes,
  isEarned,
  size = "md",
  showLabels = false,
}: MilestoneGridProps) {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size === "sm" ? "80px" : size === "lg" ? "120px" : "100px"}, 1fr))` }}
      role="list"
      aria-label="Milestone achievements"
    >
      {milestoneTypes.map((type) => (
        <MilestoneBadge
          key={type}
          milestoneType={type}
          earned={isEarned(type)}
          size={size}
          showLabel={showLabels}
        />
      ))}
    </div>
  );
}