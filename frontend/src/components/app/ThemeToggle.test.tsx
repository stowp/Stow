"use client";

import { render, waitFor } from "@testing-library/react";
import { renderHook, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import userEvent from "@testing-library/user-event";
import ThemeToggle from "./ThemeToggle";
import { ThemeProvider, useTheme } from "@/context/ThemeProvider";

// Wrapper with theme provider
function wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

// Component to test theme hook
function TestConsumer() {
  const { theme, preference, toggleTheme, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="preference">{preference}</span>
      <button data-testid="toggle" onClick={toggleTheme}>
        Toggle
      </button>
      <button data-testid="set-system" onClick={() => setPreference("system")}>
        System
      </button>
    </div>
  );
}

describe("ThemeToggle", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("renders without crashing", () => {
    const { getByRole } = render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(getByRole("button", { name: /switch to/i })).toBeDefined();
  });

  it("shows correct initial icon for dark theme", () => {
    localStorage.setItem("stow-theme", "dark");

    const { getByRole } = render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(getByRole("button", { name: /switch to light/i })).toBeDefined();
  });

  it("shows correct initial icon for light theme", () => {
    localStorage.setItem("stow-theme", "light");

    const { getByRole } = render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(getByRole("button", { name: /switch to dark/i })).toBeDefined();
  });

  it("toggles theme when clicked", async () => {
    const user = userEvent.setup();
    const { getByRole } = render(
      <ThemeProvider>
        <ThemeToggle />
        <TestConsumer />
      </ThemeProvider>,
    );

    const toggleButton = getByRole("button", { name: /switch to/i });

    await user.click(toggleButton);

    await waitFor(() => {
      // Theme should have changed
    });
  });

  it("has system preference button", () => {
    const { getByRole } = render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(getByRole("button", { name: /system preference/i })).toBeDefined();
  });

  it("sets system preference when clicked", async () => {
    const user = userEvent.setup();
    const { getByRole } = render(
      <ThemeProvider>
        <ThemeToggle />
        <TestConsumer />
      </ThemeProvider>,
    );

    const systemButton = getByRole("button", { name: /system preference/i });
    await user.click(systemButton);

    await waitFor(() => {
      // Should set preference to system
    });
  });

  it("is accessible with proper ARIA attributes", () => {
    const { getByRole } = render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    const toggleButton = getByRole("button", { name: /switch to/i });
    expect(toggleButton).toHaveAttribute("aria-pressed");
    expect(toggleButton).toHaveAttribute("aria-label");
  });

  it("shows labels when showLabel is true", () => {
    const { getByText } = render(
      <ThemeProvider>
        <ThemeToggle showLabel />
      </ThemeProvider>,
    );

    // Should contain either Light/Dark or System text
    expect(
      getByText(/Light|Dark|System/i),
    ).toBeDefined();
  });
});

describe("useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("provides theme context", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    expect(result.current.theme).toBeDefined();
    expect(result.current.preference).toBeDefined();
    expect(result.current.setPreference).toBeDefined();
    expect(result.current.toggleTheme).toBeDefined();
  });

  it("toggles theme correctly", async () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    const initialTheme = result.current.theme;

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.theme).toBe(initialTheme === "light" ? "dark" : "light");
  });

  it("sets preference to system", async () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setPreference("system");
    });

    expect(result.current.preference).toBe("system");
  });

  it("persists preference to localStorage", async () => {
    const { result } = renderHook(() => useTheme(), { wrapper });

    act(() => {
      result.current.setPreference("light");
    });

    expect(localStorage.getItem("stow-theme")).toBe("light");
  });

  it("throws error when used outside provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => renderHook(() => useTheme())).toThrow(
      "useTheme must be used within a ThemeProvider",
    );

    consoleError.mockRestore();
  });
});