import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, useTheme } from "./ThemeProvider";

function ThemeConsumer() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button onClick={toggleTheme}>toggle</button>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to dark when there is no stored preference and no light system preference", async () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("reads a stored preference on mount", async () => {
    window.localStorage.setItem("stow-theme", "light");

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("theme")).toHaveTextContent("light");
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("toggles the theme and persists the choice", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    });

    await user.click(screen.getByRole("button", { name: "toggle" }));

    await waitFor(() => {
      expect(screen.getByTestId("theme")).toHaveTextContent("light");
    });
    expect(window.localStorage.getItem("stow-theme")).toBe("light");

    await user.click(screen.getByRole("button", { name: "toggle" }));

    await waitFor(() => {
      expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    });
    expect(window.localStorage.getItem("stow-theme")).toBe("dark");
  });

  it("throws when useTheme is used outside a ThemeProvider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<ThemeConsumer />)).toThrow(
      "useTheme must be used within a ThemeProvider",
    );
    consoleError.mockRestore();
  });
});
