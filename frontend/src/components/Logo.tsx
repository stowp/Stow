"use client";

import { useId } from "react";

/**
 * Stow's logo: a rounded "S" mark plus an optional wordmark.
 *
 * Theme-aware by construction rather than by branching on a theme value:
 *  - The mark's fill is a gradient between the `--brand`/`--brand-2` CSS
 *    custom properties (defined in globals.css), so it automatically
 *    tracks whatever brand palette is active for the current theme if the
 *    app ever adds a light theme (today there is only the dark palette).
 *  - The wordmark uses `currentColor` (inherited from its container), so
 *    it's safe to drop onto a light or dark surface — a dark navbar today,
 *    a light card tomorrow — without a separate variant.
 *
 * This mirrors the pattern already used by `GithubIcon.tsx` (fill=
 * "currentColor", accepts a `className`), and replaces the inline
 * `<span>S</span>` gradient badge previously hardcoded in `Navbar.tsx`.
 */

export interface LogoProps {
  /** "mark" renders just the icon; "full" (default) adds the "Stow" wordmark. */
  variant?: "mark" | "full";
  /** Applied to the icon's <svg>. Use for sizing, e.g. "h-8 w-8". */
  className?: string;
  /** Applied to the wordmark <span>, when `variant` is "full". */
  wordmarkClassName?: string;
}

export default function Logo({
  variant = "full",
  className = "h-8 w-8",
  wordmarkClassName = "text-lg font-semibold tracking-tight",
}: LogoProps) {
  // A unique gradient id per instance avoids collisions if the logo is
  // rendered more than once on the same page (e.g. navbar + footer), since
  // SVG gradient ids are global to the document. useId() is SSR-safe (the
  // id matches between server and client render).
  const gradientId = `stow-logo-gradient-${useId()}`;

  return (
    <span className="inline-flex items-center gap-2.5">
      <svg
        viewBox="0 0 32 32"
        className={className}
        role="img"
        aria-label="Stow logo"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--brand, #2dd4bf)" />
            <stop offset="100%" stopColor="var(--brand-2, #6366f1)" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
        <path
          d="M11 12.5c0-1.8 1.7-3 4.4-3 2.3 0 4 .8 5.1 2.2l-2.1 1.7c-.7-.9-1.7-1.4-3-1.4-1.1 0-1.7.4-1.7 1 0 .7.8 1 2.6 1.4 2.9.6 4.7 1.6 4.7 4 0 2-1.9 3.4-4.9 3.4-2.5 0-4.4-.9-5.5-2.5l2.2-1.6c.7 1 1.8 1.6 3.3 1.6 1.3 0 2-.4 2-1.1 0-.7-.7-1-2.7-1.4-2.7-.6-4.4-1.6-4.4-3.9Z"
          fill="var(--background, #05070d)"
        />
      </svg>

      {variant === "full" && (
        <span className={wordmarkClassName} style={{ color: "currentColor" }}>
          Stow
        </span>
      )}
    </span>
  );
}
