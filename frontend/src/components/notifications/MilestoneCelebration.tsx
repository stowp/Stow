"use client";

import { useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { useMilestones, MILESTONES, type MilestoneType } from "@/context/MilestoneProvider";

interface MilestoneCelebrationProps {
  /** Callback when celebration is closed */
  onClose?: () => void;
}

/**
 * Confetti particle for celebration animation
 */
function Confetti({
  delay,
  x,
  color,
}: {
  delay: number;
  x: number;
  color: string;
}) {
  return (
    <div
      className="absolute h-2 w-2 rounded-sm"
      style={{
        left: `${x}%`,
        top: "-20px",
        backgroundColor: color,
        animation: `confetti-fall 3s ease-out ${delay}s forwards`,
        transform: `rotate(${Math.random() * 360}deg)`,
      }}
    />
  );
}

const CONFETTI_COLORS = [
  "#2dd4bf", // brand teal
  "#6366f1", // brand indigo
  "#a855f7", // brand purple
  "#f59e0b", // amber
  "#ec4899", // pink
];

export default function MilestoneCelebration({
  onClose,
}: MilestoneCelebrationProps) {
  const { isNewMilestone, dismissMilestone } = useMilestones();

  const handleClose = useCallback(() => {
    dismissMilestone();
    onClose?.();
  }, [dismissMilestone, onClose]);

  // Handle escape key for dismiss
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isNewMilestone) {
        handleClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isNewMilestone, handleClose]);

  // Check for reduced motion preference
  useEffect(() => {
    if (isNewMilestone) {
      const prefersReducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      if (prefersReducedMotion) {
        // Skip confetti animation but still show the modal
        const confettiElements = document.querySelectorAll("[data-confetti]");
        confettiElements.forEach((el) => {
          (el as HTMLElement).style.animation = "none";
        });
      }
    }
  }, [isNewMilestone]);

  if (!isNewMilestone) return null;

  const milestone = MILESTONES[isNewMilestone];

  // Generate confetti particles
  const confettiParticles = Array.from({ length: 50 }, (_, i) => ({
    delay: Math.random() * 2,
    x: Math.random() * 100,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  }));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="milestone-title"
      aria-describedby="milestone-description"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        aria-hidden="true"
        onClick={handleClose}
      />

      {/* Confetti container */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-32 overflow-hidden"
        aria-hidden="true"
      >
        {confettiParticles.map((particle, i) => (
          <Confetti
            key={i}
            delay={particle.delay}
            x={particle.x}
            color={particle.color}
          />
        ))}
      </div>

      {/* Milestone card */}
      <div className="relative mx-4 flex max-w-sm flex-col items-center rounded-2xl border border-border bg-card p-8 text-center shadow-2xl animate-rise">
        <button
          type="button"
          onClick={handleClose}
          aria-label="Dismiss celebration"
          className="absolute right-3 top-3 rounded-lg p-1 text-muted transition-colors hover:bg-card hover:text-foreground focus:outline-none focus:ring-2 focus:ring-brand/50"
        >
          <X className="h-5 w-5" />
        </button>

        <div
          className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-brand/10 text-4xl"
          aria-hidden="true"
        >
          {milestone.icon}
        </div>

        <p className="mb-2 text-sm font-medium text-brand">
          {milestone.tier.charAt(0).toUpperCase() + milestone.tier.slice(1)}{" "}
          Milestone Unlocked!
        </p>

        <h2
          id="milestone-title"
          className="mb-2 text-2xl font-bold text-foreground"
        >
          {milestone.title}
        </h2>

        <p id="milestone-description" className="mb-6 text-muted">
          {milestone.description}
        </p>

        <button
          type="button"
          onClick={handleClose}
          className="rounded-xl bg-brand px-6 py-2.5 font-medium text-background transition-colors hover:bg-brand/90 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:ring-offset-2 focus:ring-offset-background"
        >
          Awesome!
        </button>
      </div>

      <style jsx>{`
        @keyframes confetti-fall {
          0% {
            opacity: 1;
            transform: translateY(0) rotate(0deg);
          }
          100% {
            opacity: 0;
            transform: translateY(100vh) rotate(720deg);
          }
        }
      `}</style>
    </div>
  );
}