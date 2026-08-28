import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Logo from "./Logo";

describe("Logo", () => {
  it("renders the Stow wordmark by default (variant='full')", () => {
    render(<Logo />);
    expect(screen.getByText("Stow")).toBeInTheDocument();
  });

  it("renders an accessible label on the mark's svg", () => {
    render(<Logo />);
    expect(screen.getByRole("img", { name: "Stow logo" })).toBeInTheDocument();
  });

  it("omits the wordmark when variant='mark'", () => {
    render(<Logo variant="mark" />);
    expect(screen.queryByText("Stow")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Stow logo" })).toBeInTheDocument();
  });

  it("applies a custom className to the icon svg", () => {
    render(<Logo className="h-10 w-10" />);
    const svg = screen.getByRole("img", { name: "Stow logo" });
    expect(svg).toHaveClass("h-10", "w-10");
  });

  it("applies a custom wordmarkClassName to the wordmark", () => {
    render(<Logo wordmarkClassName="text-2xl font-bold" />);
    expect(screen.getByText("Stow")).toHaveClass("text-2xl", "font-bold");
  });

  it("is theme-adaptive: the wordmark uses currentColor so it inherits its container's text color", () => {
    render(
      <div style={{ color: "rgb(255, 0, 0)" }}>
        <Logo />
      </div>,
    );
    const wordmark = screen.getByText("Stow");
    expect(wordmark).toHaveStyle({ color: "currentColor" });
  });

  it("renders distinct gradient ids across multiple instances on the same page", () => {
    const { container } = render(
      <div>
        <Logo />
        <Logo />
      </div>,
    );
    const gradientIds = Array.from(
      container.querySelectorAll("linearGradient"),
    ).map((el) => el.id);

    expect(gradientIds).toHaveLength(2);
    expect(new Set(gradientIds).size).toBe(2);
    for (const id of gradientIds) {
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it("references the brand CSS custom properties for the mark's gradient (theme-token driven, not a hardcoded color)", () => {
    const { container } = render(<Logo />);
    const stops = container.querySelectorAll("stop");

    expect(stops).toHaveLength(2);
    expect(stops[0].getAttribute("stop-color")).toContain("--brand");
    expect(stops[1].getAttribute("stop-color")).toContain("--brand-2");
  });
});
