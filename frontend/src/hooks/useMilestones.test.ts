"use client";

import { renderHook, act, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { useMilestoneCheck, useMilestoneStats } from "./useMilestones";
import { MilestoneProvider } from "@/context/MilestoneProvider";
import { SessionProvider } from "@/context/SessionProvider";

// Wrapper with providers
function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <MilestoneProvider>{children}</MilestoneProvider>
    </SessionProvider>
  );
}

describe("useMilestoneCheck", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("checks and awards first_deposit milestone", async () => {
    const { result } = renderHook(() => useMilestoneCheck(), { wrapper });

    await act(async () => {
      result.current.check("first_deposit", true);
    });

    await waitFor(() => {
      expect(result.current.achievements.has("first_deposit")).toBe(true);
    });
  });

  it("checks deposit milestones correctly", async () => {
    const { result } = renderHook(() => useMilestoneCheck(), { wrapper });

    await act(async () => {
      result.current.checkDeposit(150, true);
    });

    await waitFor(() => {
      expect(result.current.achievements.has("first_deposit")).toBe(true);
      expect(result.current.achievements.has("saved_100")).toBe(true);
      expect(result.current.achievements.has("saved_1000")).toBe(false);
      expect(result.current.achievements.has("saved_10000")).toBe(false);
    });
  });

  it("checks goal milestones correctly", async () => {
    const { result } = renderHook(() => useMilestoneCheck(), { wrapper });

    await act(async () => {
      result.current.checkGoal(true, false);
    });

    await waitFor(() => {
      expect(result.current.achievements.has("first_goal_created")).toBe(true);
      expect(result.current.achievements.has("goal_completed")).toBe(false);
    });
  });

  it("checks streak milestones correctly", async () => {
    const { result } = renderHook(() => useMilestoneCheck(), { wrapper });

    await act(async () => {
      result.current.checkStreak(7);
    });

    await waitFor(() => {
      expect(result.current.achievements.has("streak_7_days")).toBe(true);
      expect(result.current.achievements.has("streak_30_days")).toBe(false);
    });
  });

  it("checks group milestones correctly", async () => {
    const { result } = renderHook(() => useMilestoneCheck(), { wrapper });

    await act(async () => {
      result.current.checkGroup(true);
    });

    await waitFor(() => {
      expect(result.current.achievements.has("first_group_joined")).toBe(true);
    });
  });

  it("checks referral milestones correctly", async () => {
    const { result } = renderHook(() => useMilestoneCheck(), { wrapper });

    await act(async () => {
      result.current.checkReferral(true);
    });

    await waitFor(() => {
      expect(result.current.achievements.has("referral_signup")).toBe(true);
    });
  });
});

describe("useMilestoneStats", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("returns correct stats when no milestones earned", () => {
    const { result } = renderHook(() => useMilestoneStats(), { wrapper });

    expect(result.current.totalMilestones).toBe(10);
    expect(result.current.earnedCount).toBe(0);
    expect(result.current.progress).toBe(0);
  });

  it("returns correct stats when milestones earned", async () => {
    const { result: checkResult } = renderHook(() => useMilestoneCheck(), {
      wrapper,
    });

    await act(async () => {
      checkResult.current.check("first_deposit", true);
      checkResult.current.check("saved_100", true);
      checkResult.current.check("first_goal_created", true);
    });

    const { result } = renderHook(() => useMilestoneStats(), { wrapper });

    await waitFor(() => {
      expect(result.current.earnedCount).toBe(3);
      expect(result.current.progress).toBe(30);
    });
  });
});