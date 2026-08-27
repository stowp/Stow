import { render, screen, fireEvent } from "@testing-library/react";
import GoalCard from "./GoalCard";

const activeGoal = {
  on_chain_id: "goal-1",
  name: "Vacation Fund",
  target_amount: "100000000",
  current_amount: "25000000",
  status: "active" as const,
};

describe("GoalCard", () => {
  it("renders the goal name and formatted amounts", () => {
    render(<GoalCard goal={activeGoal} />);
    expect(screen.getByText("Vacation Fund")).toBeInTheDocument();
    expect(screen.getByText("2.5 / 10 XLM")).toBeInTheDocument();
  });

  it("shows the correct percentage on the progress ring", () => {
    render(<GoalCard goal={activeGoal} />);
    const ring = screen.getByTestId("progress-ring");
    expect(ring).toHaveAttribute("data-progress", "25");
  });

  it("shows a contribute button for an active goal", () => {
    render(<GoalCard goal={activeGoal} />);
    expect(screen.getByRole("button", { name: "Contribute" })).toBeInTheDocument();
  });

  it("calls onContribute with the goal id when clicked", () => {
    const onContribute = jest.fn();
    render(<GoalCard goal={activeGoal} onContribute={onContribute} />);
    fireEvent.click(screen.getByRole("button", { name: "Contribute" }));
    expect(onContribute).toHaveBeenCalledWith("goal-1");
  });

  it("shows a reached badge and no contribute button for a reached goal", () => {
    render(<GoalCard goal={{ ...activeGoal, status: "reached", current_amount: "100000000" }} />);
    expect(screen.getByTestId("goal-status-badge")).toHaveTextContent("Reached");
    expect(screen.queryByRole("button", { name: "Contribute" })).not.toBeInTheDocument();
  });

  it("shows a claimed badge for a claimed goal", () => {
    render(<GoalCard goal={{ ...activeGoal, status: "claimed", current_amount: "100000000" }} />);
    expect(screen.getByTestId("goal-status-badge")).toHaveTextContent("Claimed");
  });

  it("caps the progress ring at 100% even if current exceeds target", () => {
    render(<GoalCard goal={{ ...activeGoal, current_amount: "150000000" }} />);
    const ring = screen.getByTestId("progress-ring");
    expect(ring).toHaveAttribute("data-progress", "100");
  });

  it("handles a zero target without dividing by zero", () => {
    render(<GoalCard goal={{ ...activeGoal, target_amount: "0" }} />);
    const ring = screen.getByTestId("progress-ring");
    expect(ring).toHaveAttribute("data-progress", "0");
  });
});
