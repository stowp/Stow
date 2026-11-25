import { describe, expect, it } from "vitest";
import { checkContribution, summarizeGoalContributions } from "./goalContributions";

describe("summarizeGoalContributions", () => {
  it("computes total progress and individual percentages, largest first", () => {
    const s = summarizeGoalContributions({ alice: 30, bob: 70, carol: 0 }, 200);
    expect(s.total).toBe(100);
    expect(s.progressPercent).toBe(50);
    expect(s.contributors.map((c) => c.address)).toEqual(["bob", "alice"]);
    expect(s.contributors[0].percent).toBe(70);
    expect(s.contributors[1].percent).toBe(30);
  });

  it("clamps progress at 100% and handles a zero target", () => {
    expect(summarizeGoalContributions({ a: 500 }, 100).progressPercent).toBe(100);
    expect(summarizeGoalContributions({ a: 5 }, 0).progressPercent).toBe(0);
  });

  it("ignores negative and non-finite amounts", () => {
    const s = summarizeGoalContributions({ a: -5, b: NaN, c: 10 }, 100);
    expect(s.contributors.map((c) => c.address)).toEqual(["c"]);
    expect(s.total).toBe(10);
  });

  it("reports remaining allowance per contributor when a limit is set", () => {
    const s = summarizeGoalContributions({ a: 80, b: 150 }, 1000, 100);
    const byAddr = Object.fromEntries(s.contributors.map((c) => [c.address, c.remainingAllowance]));
    expect(byAddr).toEqual({ a: 20, b: 0 });
  });
});

describe("checkContribution", () => {
  it("allows any positive amount when there is no limit", () => {
    expect(checkContribution(999, 5)).toEqual({ allowed: true, remainingAllowance: null });
  });

  it("rejects amounts above the per-user limit and reports remaining room", () => {
    expect(checkContribution(40, 70, 100)).toEqual({
      allowed: false,
      reason: "over-limit",
      remainingAllowance: 60,
    });
  });

  it("accepts amounts within the limit and reports what is left", () => {
    expect(checkContribution(40, 25, 100)).toEqual({ allowed: true, remainingAllowance: 35 });
  });

  it("rejects zero, negative and non-finite amounts", () => {
    expect(checkContribution(0, 0).reason).toBe("invalid-amount");
    expect(checkContribution(0, -1).allowed).toBe(false);
    expect(checkContribution(0, Number.NaN).allowed).toBe(false);
  });
});
