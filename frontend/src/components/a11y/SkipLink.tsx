"use client";

import { useCallback, useRef, type AnchorHTMLAttributes } from "react";

interface SkipLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** The target element ID to skip to (without #) */
  targetId: string;
  /** Custom text for the link */
  children: React.ReactNode;
}

/**
 * Skip link component for keyboard navigation.
 * Allows users to bypass repetitive navigation and jump to main content.
 */
export default function SkipLink({
  targetId,
  children,
  className = "",
  ...props
}: SkipLinkProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      const target = document.getElementById(targetId);
      if (target) {
        target.tabIndex = -1;
        target.focus();
        target.scrollIntoView({ behavior: "smooth" });
      }
    },
    [targetId],
  );

  return (
    <a
      href={`#${targetId}`}
      onClick={handleClick}
      className={`sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:text-foreground focus:outline-none focus:ring-2 focus:ring-brand ${className}`}
      {...props}
    >
      {children}
    </a>
  );
}

/**
 * Hook for managing focus within a container after navigation
 */
export function useSkipLink(targetId: string) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        const target = document.getElementById(targetId);
        if (target) {
          e.preventDefault();
          target.tabIndex = -1;
          target.focus();
        }
      }
    },
    [targetId],
  );

  return { containerRef, handleKeyDown };
}