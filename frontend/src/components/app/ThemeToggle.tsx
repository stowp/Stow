"use client";

import { useCallback, useEffect, useState } from "react";
import { Moon, Sun, Monitor } from "lucide-react";
import { useTheme } from "@/context/ThemeProvider";

interface ThemeToggleProps {
  /** Additional CSS classes */
  className?: string;
  /** Show label text alongside icon */
  showLabel?: boolean;
}

/**
 * Theme toggle button for switching between light and dark modes.
 * Respects system preference detection and persists choice to localStorage.
 * Fully accessible with ARIA labels and keyboard support.
 */
export default function ThemeToggle({
  className = "",
  showLabel = false,
}: ThemeToggleProps) {
  const { theme, toggleTheme, preference, setPreference } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  const isLight = theme === "light";
  const isSystem = preference === "system";

  const getSystemLabel = () => {
    if (isSystem) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "Using system dark mode"
        : "Using system light mode";
    }
    return "Use system preference";
  };

  const handleToggleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTheme();
      }
    },
    [toggleTheme],
  );

  const handleSystemKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setPreference("system");
      }
    },
    [setPreference],
  );

  if (!mounted) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <div className="h-9 w-9 animate-pulse rounded-lg border border-border bg-card" />
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1 ${className}`}
      role="group"
      aria-label="Theme preferences"
    >
      <button
        type="button"
        onClick={toggleTheme}
        onKeyDown={handleToggleKeyDown}
        aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
        aria-pressed={!isSystem && isLight}
        className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-card hover:text-foreground focus:outline-none focus:ring-2 focus:ring-brand/50"
      >
        <span className="relative h-4 w-4" aria-hidden="true">
          <Sun
            className={`absolute inset-0 h-4 w-4 transition-all duration-200 ${
              isLight ? "opacity-100 rotate-0" : "opacity-0 rotate-90"
            }`}
          />
          <Moon
            className={`absolute inset-0 h-4 w-4 transition-all duration-200 ${
              isLight ? "opacity-0 -rotate-90" : "opacity-100 rotate-0"
            }`}
          />
        </span>
        {showLabel && <span>{isLight ? "Light" : "Dark"}</span>}
      </button>

      <button
        type="button"
        onClick={() => setPreference("system")}
        onKeyDown={handleSystemKeyDown}
        aria-pressed={isSystem}
        aria-label={getSystemLabel()}
        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand/50 ${
          isSystem
            ? "bg-brand/10 text-brand"
            : "text-muted hover:bg-card hover:text-foreground"
        }`}
      >
        <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
        {showLabel && <span>System</span>}
      </button>
    </div>
  );
}