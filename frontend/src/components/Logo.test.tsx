import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import Logo from "./Logo";

describe("Logo", () => {
  it("renders an svg with the default size", () => {
    const { container } = render(<Logo />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("width", "32");
    expect(svg).toHaveAttribute("height", "32");
  });

  it("renders at a custom size", () => {
    const { container } = render(<Logo size={48} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "48");
    expect(svg).toHaveAttribute("height", "48");
  });

  it("is accessible with a title by default", () => {
    const { container } = render(<Logo />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("role", "img");
    expect(svg).toHaveAttribute("aria-label", "Stow");
  });

  it("can be marked purely decorative with an empty title", () => {
    const { container } = render(<Logo title="" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).not.toHaveAttribute("role");
  });

  it("renders its gradient fill consistently regardless of a surrounding dark-theme wrapper", () => {
    // This app has no light/dark toggle (dark-only, --background is fixed),
    // so "renders in both themes" is exercised as: the gradient-based mark
    // renders identically whether or not a dark-theme class wraps it —
    // i.e. it doesn't rely on CSS custom properties that could be
    // overridden or missing under a different theme context, since the
    // gradient stop colors are hardcoded in the SVG itself.
    const dark = render(
      <div data-theme="dark">
        <Logo />
      </div>
    );
    const light = render(
      <div data-theme="light">
        <Logo />
      </div>
    );

    const darkGradientStops = dark.container.querySelectorAll("stop");
    const lightGradientStops = light.container.querySelectorAll("stop");

    expect(darkGradientStops).toHaveLength(2);
    expect(lightGradientStops).toHaveLength(2);
    expect(darkGradientStops[0]?.getAttribute("stop-color")).toBe(
      lightGradientStops[0]?.getAttribute("stop-color")
    );
    expect(darkGradientStops[1]?.getAttribute("stop-color")).toBe(
      lightGradientStops[1]?.getAttribute("stop-color")
    );
  });

  it("renders multiple instances on the same page with distinct gradient ids", () => {
    // Regression check for the navbar+footer collision this component's
    // own docstring warns about: two instances must not share a
    // <linearGradient id>.
    const { container } = render(
      <>
        <Logo />
        <Logo />
      </>
    );
    const gradientIds = Array.from(container.querySelectorAll("linearGradient")).map((el) =>
      el.getAttribute("id")
    );
    expect(gradientIds).toHaveLength(2);
    expect(new Set(gradientIds).size).toBe(2);
  });
});
