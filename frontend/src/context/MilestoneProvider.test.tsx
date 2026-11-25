"use client";

import { render, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { MilestoneProvider, useMilestones, MILESTONES, type MilestoneType } from "./MilestoneProvider";

// Test component to access milestone context
function TestComponent({
  onMilestoneChange,
}: {
  onMilestoneChange?: (milestone: MilestoneType | null) => void;
}) {
  const { achievements, isNewMilestone, checkAndAwardMilestone, hasMilestone } =
    useMilestones();

  return (
    <div>
      <div data-testid="achievements">
        {[...achievements].join(", ") || "none"}
      </div>
      <div data-testid="new-milestone">{isNewMilestone || "none"}</div>
      <button
        data-testid="award-first-deposit"
        onClick={() => checkAndAwardMilestone("first_deposit", true)}
      >
        Award First Deposit
      </button>
      <button
        data-testid="award-100"
        onClick={() => checkAndAwardMilestone("saved_100", true)}
      >
        Award 100 Saved
      </button>
      <button data-testid="dismiss" onClick={() => {}}>
        Dismiss
      </button>
      <div data-testid="has-first-deposit">
        {hasMilestone("first_deposit") ? "yes" : "no"}
      </div>
    </div>
  );
}

describe("MilestoneProvider", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("provides empty achievements initially", () => {
    const { getByTestId } = render(
      <MilestoneProvider>
        <TestComponent />
      </MilestoneProvider>,
    );

    expect(getByTestId("achievements").textContent).toBe("none");
  });

  it("awards milestone when condition is true", async () => {
    const { getByTestId } = render(
      <MilestoneProvider>
        <TestComponent />
      </MilestoneProvider>,
    );

    await act(async () => {
      getByTestId("award-first-deposit").click();
    });

    await waitFor(() => {
      expect(getByTestId("achievements").textContent).toBe("first_deposit");
    });
  });

  it("does not award milestone when condition is false", async () => {
    const { getByTestId } = render(
      <MilestoneProvider>
        <TestComponent />
      </MilestoneProvider>,
    );

    await act(async () => {
      getByTestId("award-100").click();
    });

    await waitFor(() => {
      expect(getByTestId("achievements").textContent).toBe("none");
    });
  });

  it("persists milestones to localStorage", async () => {
    const { getByTestId } = render(
      <MilestoneProvider>
        <TestComponent />
      </MilestoneProvider>,
    );

    await act(async () => {
      getByTestId("award-first-deposit").click();
    });

    await waitFor(() => {
      expect(localStorage.getItem("stow-milestones")).toContain("first_deposit");
    });
  });

  it("hasMilestone returns correct value", async () => {
    const { getByTestId } = render(
      <MilestoneProvider>
        <TestComponent />
      </MilestoneProvider>,
    );

    expect(getByTestId("has-first-deposit").textContent).toBe("no");

    await act(async () => {
      getByTestId("award-first-deposit").click();
    });

    await waitFor(() => {
      expect(getByTestId("has-first-deposit").textContent).toBe("yes");
    });
  });

  it("throws error when used outside provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    
    expect(() => render(<TestComponent />)).toThrow(
      "useMilestones must be used within a MilestoneProvider",
    );
    
    consoleError.mockRestore();
  });
});

describe("MILESTONES", () => {
  it("contains all expected milestones", () => {
    const expectedMilestones: MilestoneType[] = [
      "first_deposit",
      "saved_100",
      "saved_1000",
      "saved_10000",
      "first_goal_created",
      "goal_completed",
      "streak_7_days",
      "streak_30_days",
      "first_group_joined",
      "referral_signup",
    ];

    expectedMilestones.forEach((id) => {
      expect(MILESTONES[id]).toBeDefined();
      expect(MILESTONES[id].id).toBe(id);
      expect(MILESTONES[id].title).toBeDefined();
      expect(MILESTONES[id].description).toBeDefined();
      expect(MILESTONES[id].icon).toBeDefined();
      expect(["bronze", "silver", "gold", "platinum"]).toContain(
        MILESTONES[id].tier,
      );
    });
  });
});