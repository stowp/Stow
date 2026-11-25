import { describe, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ConfirmDialog from "./ConfirmDialog";
import Toast from "./Toast";
import ErrorRetry from "./ErrorRetry";
import { expectNoSeriousViolations } from "@/test/axe";
import AriaLive from "@/components/a11y/AriaLive";

describe("UI component accessibility (axe)", () => {
  it("announces updates using the configured politeness", () => {
    const { rerender } = render(<AriaLive message="Savings summary loaded." />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveTextContent("Savings summary loaded.");

    rerender(<AriaLive message="Could not load savings." politeness="assertive" />);
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  });

  it("ConfirmDialog reports no serious violations in its open state", async () => {
    const { container } = render(
      <ConfirmDialog
        open
        title="Delete goal"
        body="This cannot be undone."
        variant="danger"
        confirmText="Delete"
        cancelText="Cancel"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    // The dialog must expose a labelled, modal role.
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    await expectNoSeriousViolations(container);
  });

  it("Toast reports no serious violations for an assertive (error) variant", async () => {
    const { container } = render(
      <Toast toast={{ id: "1", variant: "error", message: "Request failed" }} onDismiss={() => {}} />,
    );
    expect(container.querySelector('[aria-live="assertive"]')).not.toBeNull();
    await expectNoSeriousViolations(container);
  });

  it("Toast reports no serious violations for a polite (success) variant with a link", async () => {
    const { container } = render(
      <Toast
        toast={{
          id: "2",
          variant: "success",
          message: "Deposit confirmed",
          txUrl: "https://example.com/tx",
          txLabel: "View on explorer",
        }}
        onDismiss={() => {}}
      />,
    );
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    await expectNoSeriousViolations(container);
  });

  it("ErrorRetry reports no serious violations", async () => {
    const { container } = render(
      <ErrorRetry error={new Error("Network connection failed")} onRetry={() => {}} />,
    );
    await expectNoSeriousViolations(container);
  });
});
