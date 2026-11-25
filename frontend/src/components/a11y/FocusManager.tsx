"use client";

import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";

type Direction = "horizontal" | "vertical" | "both";

interface FocusTrapOptions {
  /** Whether the focus trap is active */
  isActive: boolean;
  /** Callback when focus trap is exited via Escape */
  onEscape?: () => void;
}

/**
 * Focus trap - keeps keyboard focus within a container
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement>,
  options: FocusTrapOptions,
) {
  const { isActive, onEscape } = options;

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    const container = containerRef.current;
    const focusableSelector =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

    const getFocusableElements = () => {
      return Array.from(
        container.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((el) => !el.hasAttribute("disabled"));
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    };

    container.addEventListener("keydown", handleKeyDown as any);

    // Focus first element when trap activates
    const focusableElements = getFocusableElements();
    if (focusableElements.length > 0) {
      focusableElements[0].focus();
    }

    return () => {
      container.removeEventListener("keydown", handleKeyDown as any);
    };
  }, [isActive, containerRef]);
}

/**
 * Arrow key navigation for grid-like layouts
 */
export function useArrowKeyNavigation(
  itemCount: number,
  options: {
    /** Grid columns count */
    columns: number;
    /** Current active index */
    activeIndex: number;
    /** Callback when index changes */
    onIndexChange: (index: number) => void;
    /** Allow wrapping at boundaries */
    wrap?: boolean;
  },
) {
  const { columns, activeIndex, onIndexChange, wrap = true } = options;

  const getNextIndex = useCallback(
    (current: number, delta: number): number => {
      const rows = Math.ceil(itemCount / columns);
      const currentRow = Math.floor(current / columns);
      const currentCol = current % columns;

      let newRow = currentRow;
      let newCol = currentCol;

      if (delta === -columns) {
        // Up
        newRow = currentRow - 1;
      } else if (delta === columns) {
        // Down
        newRow = currentRow + 1;
      } else if (delta === -1) {
        // Left
        newCol = currentCol - 1;
      } else if (delta === 1) {
        // Right
        newCol = currentCol + 1;
      }

      // Handle boundaries
      if (wrap) {
        if (newRow < 0) newRow = rows - 1;
        if (newRow >= rows) newRow = 0;
        if (newCol < 0) newCol = columns - 1;
        if (newCol >= columns) newCol = 0;
      } else {
        if (newRow < 0 || newRow >= rows || newCol < 0 || newCol >= columns) {
          return current;
        }
      }

      let newIndex = newRow * columns + newCol;
      if (newIndex >= itemCount) newIndex = itemCount - 1;
      if (newIndex < 0) newIndex = 0;

      return newIndex;
    },
    [itemCount, columns, wrap],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const delta = (() => {
        switch (e.key) {
          case "ArrowUp":
            return -columns;
          case "ArrowDown":
            return columns;
          case "ArrowLeft":
            return -1;
          case "ArrowRight":
            return 1;
          default:
            return null;
        }
      })();

      if (delta === null) return;

      e.preventDefault();
      const newIndex = getNextIndex(activeIndex, delta);
      if (newIndex !== activeIndex) {
        onIndexChange(newIndex);
      }
    },
    [activeIndex, columns, getNextIndex, onIndexChange],
  );

  return { handleKeyDown };
}

/**
 * Announce to screen readers using a live region
 */
export function useLiveAnnouncer() {
  const announcerRef = useRef<HTMLDivElement>(null);

  const announce = useCallback((message: string, priority: "polite" | "assertive" = "polite") => {
    if (announcerRef.current) {
      announcerRef.current.setAttribute("aria-live", priority);
      announcerRef.current.textContent = "";
      // Force reflow to ensure announcement
      void announcerRef.current.offsetHeight;
      announcerRef.current.textContent = message;
    }
  }, []);

  return { announcerRef, announce };
}

/**
 * Focus ring for keyboard navigation visibility
 */
interface FocusRingProps {
  /** Whether to show focus ring */
  visible: boolean;
  children: React.ReactNode;
}

export function FocusRing({ visible, children }: FocusRingProps) {
  return (
    <span
      className={`focus-ring ${visible ? "focus-ring-visible" : ""}`}
      data-visible={visible}
    >
      {children}
    </span>
  );
}

// CSS for focus ring (should be in globals.css):
/*
.focus-ring {
  outline: none;
}
.focus-ring[data-visible="true"] {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
*/