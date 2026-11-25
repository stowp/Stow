import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SavingsGrowthChart from "./SavingsGrowthChart";
import { calculateSavings } from "@/lib/savingsCalculator";

const project = (durationMonths: number) =>
  calculateSavings({
    initialAmount: 1000,
    monthlyDeposit: 100,
    durationMonths,
    annualRatePercent: 5,
    compounding: "monthly",
  }).points;

describe("SavingsGrowthChart", () => {
  it("draws principal and interest areas with a balance line", () => {
    const { container } = render(<SavingsGrowthChart points={project(24)} />);

    expect(container.querySelectorAll("path")).toHaveLength(3);
    expect(screen.getByText("Principal")).toBeInTheDocument();
    expect(screen.getByText("Interest earned")).toBeInTheDocument();
  });

  it("describes the projection for assistive tech", () => {
    render(<SavingsGrowthChart points={project(120)} />);

    const chart = screen.getByRole("img", { name: "Projected savings growth" });
    expect(chart).toHaveAccessibleDescription(
      /from 1K to .* over 10 years, of which 13K is principal and .* is interest/,
    );
  });

  it("labels the axes", () => {
    render(<SavingsGrowthChart points={project(60)} />);

    expect(screen.getByText("0y")).toBeInTheDocument();
    expect(screen.getByText("5y")).toBeInTheDocument();
  });

  it("uses months on the axis for short projections", () => {
    render(<SavingsGrowthChart points={project(5)} />);

    expect(screen.getByText("5m")).toBeInTheDocument();
  });

  it("thins very long projections but keeps the final point", () => {
    const points = project(600);
    const { container } = render(<SavingsGrowthChart points={points} />);

    const balanceLine = container.querySelectorAll("path")[2].getAttribute("d")!;
    const plotted = balanceLine.split(" L").length;
    expect(plotted).toBeLessThanOrEqual(130);
    expect(plotted).toBeGreaterThan(50);
    expect(screen.getByText("50y")).toBeInTheDocument();
  });

  it("does not crash on a flat zero projection", () => {
    const points = calculateSavings({
      initialAmount: 0,
      monthlyDeposit: 0,
      durationMonths: 12,
      annualRatePercent: 0,
      compounding: "monthly",
    }).points;

    const { container } = render(<SavingsGrowthChart points={points} />);

    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("does not crash with no points", () => {
    const { container } = render(<SavingsGrowthChart points={[]} />);

    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAccessibleDescription(
      "No projection to show.",
    );
  });
});
