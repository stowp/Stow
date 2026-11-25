import { useRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFocusManagement } from "./useFocusManagement";

function FocusTarget({ route }: { route: string }) {
  const targetRef = useRef<HTMLElement | null>(null);
  useFocusManagement(targetRef, route);

  return (
    <main ref={targetRef} tabIndex={-1}>
      {route}
    </main>
  );
}

describe("useFocusManagement", () => {
  it("moves focus to the target when the route changes", () => {
    const { rerender, getByRole } = render(<FocusTarget route="/dashboard" />);
    const main = getByRole("main");

    expect(document.activeElement).not.toBe(main);

    rerender(<FocusTarget route="/savings/goals" />);
    expect(document.activeElement).toBe(main);
  });
});
