/**
 * Stow's SVG wordmark icon — a stack of three coins fading toward the
 * brand gradient, standing in for "stowing away savings". Replaces the
 * plain letter-mark ("S" in a gradient box) previously duplicated in the
 * navbar and footer.
 *
 * The gradient IDs are suffixed with a caller-provided `id` (auto-generated
 * with React's `useId` when omitted) so multiple instances of this
 * component on the same page — e.g. navbar + footer — don't collide over
 * a shared `<linearGradient id="...">`, which would otherwise make every
 * instance after the first render unstyled in some browsers.
 */
"use client";

import { useId } from "react";

export interface LogoProps {
  /** Pixel size of the square icon (width and height). Default: 32. */
  size?: number;
  /** Additional class names on the root <svg>. */
  className?: string;
  /** Accessible label. Pass `""` to mark the icon purely decorative
   * (e.g. when adjacent text already says "Stow"). */
  title?: string;
}

export default function Logo({ size = 32, className, title = "Stow" }: LogoProps) {
  const reactId = useId();
  const gradientId = `stow-logo-gradient-${reactId}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
    >
      <rect width="32" height="32" rx="8" fill={`url(#${gradientId})`} />
      {/* Three stacked coins, largest at the base — "stowed" savings. */}
      <ellipse cx="16" cy="21" rx="9" ry="3" fill="white" fillOpacity="0.95" />
      <ellipse cx="16" cy="21" rx="9" ry="3" fill="none" stroke="white" strokeOpacity="0.4" />
      <ellipse cx="16" cy="16.5" rx="7" ry="2.5" fill="white" fillOpacity="0.95" />
      <ellipse cx="16" cy="16.5" rx="7" ry="2.5" fill="none" stroke="white" strokeOpacity="0.4" />
      <ellipse cx="16" cy="12.5" rx="5" ry="2" fill="white" />
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#6366f1" />
        </linearGradient>
      </defs>
    </svg>
  );
}
