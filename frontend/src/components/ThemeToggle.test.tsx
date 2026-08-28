import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ThemeToggle from "./ThemeToggle";
import { ThemeProvider } from "@/context/ThemeProvider";

describe("ThemeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders a button labeled for switching to light theme by default", async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /switch to light theme/i }),
      ).toBeInTheDocument();
    });
  });

  it("switches label and pressed state after a click", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    const button = await screen.findByRole("button", {
      name: /switch to light theme/i,
    });
    expect(button).toHaveAttribute("aria-pressed", "false");

    await user.click(button);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /switch to dark theme/i }),
      ).toHaveAttribute("aria-pressed", "true");
    });
  });
});
