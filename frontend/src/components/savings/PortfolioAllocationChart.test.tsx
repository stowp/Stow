import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SavingsSummary } from "@/hooks/useSavingsSummary";
import PortfolioAllocationChart from "./PortfolioAllocationChart";

const summary: SavingsSummary = {
  address: "GADDR",
  products: [
    { product: "flexible", total: "5000000000" },
    { product: "goals", total: "2500000000" },
  ],
  total: "7500000000",
};

describe("PortfolioAllocationChart", () => {
  it("renders category slices and allocation values", () => {
    render(<PortfolioAllocationChart summary={summary} isLoading={false} />);

    expect(screen.getByTestId("portfolio-allocation-slice-flexible")).toBeInTheDocument();
    expect(screen.getByTestId("portfolio-allocation-slice-goals")).toBeInTheDocument();
    expect(screen.getByText("Flexible savings")).toBeInTheDocument();
    expect(screen.getByText("Savings goals")).toBeInTheDocument();
    expect(screen.getByText("66.7%", { selector: "span" })).toBeInTheDocument();
  });

  it("shows a category tooltip on hover and keyboard focus", () => {
    render(<PortfolioAllocationChart summary={summary} isLoading={false} />);

    const flexibleSlice = screen.getByTestId("portfolio-allocation-slice-flexible");
    const chart = screen.getByRole("group", { name: "Savings allocation by category" });
    expect(chart).toHaveAccessibleDescription(
      /Total savings: 750 XLM\. Flexible savings: 500 XLM, 66\.7 percent/,
    );

    fireEvent.mouseEnter(flexibleSlice);
    expect(screen.getByTestId("portfolio-allocation-tooltip")).toHaveTextContent(
      "Flexible savings: 500 XLM (66.7%)",
    );

    fireEvent.mouseLeave(flexibleSlice);
    fireEvent.focus(flexibleSlice);
    expect(screen.getByTestId("portfolio-allocation-tooltip")).toHaveTextContent(
      "Flexible savings: 500 XLM (66.7%)",
    );

    fireEvent.keyDown(flexibleSlice, { key: "Enter" });
    expect(flexibleSlice).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a clear empty state when all categories are zero", () => {
    const emptySummary = { ...summary, products: summary.products.map((product) => ({ ...product, total: "0" })) };
    render(<PortfolioAllocationChart summary={emptySummary} isLoading={false} />);

    expect(screen.getByText("No savings allocated yet")).toBeInTheDocument();
    expect(screen.queryByTestId("portfolio-allocation-slice-flexible")).not.toBeInTheDocument();
  });
});