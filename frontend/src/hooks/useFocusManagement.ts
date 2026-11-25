import { useEffect, useRef, type RefObject } from "react";

/**
 * Moves focus to a page landmark when client-side navigation changes its key.
 * The initial render is left alone so loading or hydration does not steal focus.
 */
export function useFocusManagement<T extends HTMLElement>(
  targetRef: RefObject<T | null>,
  focusKey: string,
) {
  const previousKey = useRef<string | null>(null);

  useEffect(() => {
    if (previousKey.current !== null && previousKey.current !== focusKey) {
      targetRef.current?.focus();
    }

    previousKey.current = focusKey;
  }, [focusKey, targetRef]);
}
