import { describe, expect, it } from "vitest";
import {
  buildCompletionCalendar,
  habitStrength,
  localDateKey,
  nextReminderTime,
} from "./savingsHabits";

// Local-time constructors keep these tests independent of the runner's TZ.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

describe("buildCompletionCalendar", () => {
  it("returns the last N local days, oldest first, marking completed days", () => {
    const today = at(2026, 3, 10);
    const cal = buildCompletionCalendar([at(2026, 3, 8), at(2026, 3, 10, 23)], 4, today);
    expect(cal.map((d) => d.date)).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
    expect(cal.map((d) => d.completed)).toEqual([false, true, false, true]);
  });
});

describe("habitStrength", () => {
  it("is 0 with no completions", () => {
    expect(habitStrength([], "daily", at(2026, 3, 10))).toBe(0);
  });

  it("scores daily habits over the last 28 days, counting each day once", () => {
    const today = at(2026, 3, 28);
    const completions = [at(2026, 3, 28, 8), at(2026, 3, 28, 20), at(2026, 3, 27)];
    // 2 distinct days out of 28 -> 7%
    expect(habitStrength(completions, "daily", today)).toBe(7);
  });

  it("scores weekly habits over the last 4 Monday-based weeks", () => {
    // 2026-03-10 is a Tuesday; the current week started Monday 2026-03-09.
    const today = at(2026, 3, 10);
    const completions = [at(2026, 3, 10), at(2026, 3, 2), at(2026, 2, 23)];
    // Weeks of 2/23, 3/2 and 3/9 are hit -> 3 of 4 = 75%.
    expect(habitStrength(completions, "weekly", today)).toBe(75);
  });

  it("ignores future completions", () => {
    expect(habitStrength([at(2026, 4, 1)], "daily", at(2026, 3, 10))).toBe(0);
  });
});

describe("nextReminderTime", () => {
  const today = at(2026, 3, 10, 8);

  it("returns null when reminders are off", () => {
    expect(nextReminderTime({ id: "h", name: "x", frequency: "daily" }, [], today)).toBeNull();
  });

  it("schedules a daily reminder later today when it has not been done", () => {
    const t = nextReminderTime({ id: "h", name: "x", frequency: "daily", reminderHour: 18 }, [], today);
    expect(localDateKey(t!)).toBe("2026-03-10");
    expect(t!.getHours()).toBe(18);
  });

  it("moves a daily reminder to tomorrow once today is completed", () => {
    const habit = { id: "h", name: "x", frequency: "daily" as const, reminderHour: 18 };
    const t = nextReminderTime(habit, [at(2026, 3, 10, 9)], today);
    expect(localDateKey(t!)).toBe("2026-03-11");
  });

  it("schedules weekly reminders on the next Monday when this week is done", () => {
    const habit = { id: "h", name: "x", frequency: "weekly" as const, reminderHour: 9 };
    const t = nextReminderTime(habit, [at(2026, 3, 10)], today);
    // 2026-03-16 is the Monday after the Tuesday completion.
    expect(localDateKey(t!)).toBe("2026-03-16");
    expect(t!.getHours()).toBe(9);
  });

  it("rejects out-of-range reminder hours", () => {
    expect(
      nextReminderTime({ id: "h", name: "x", frequency: "daily", reminderHour: 24 }, [], today),
    ).toBeNull();
  });
});
