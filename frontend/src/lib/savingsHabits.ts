/**
 * Savings habit tracker helpers (issue #543).
 *
 * A habit is a recurring savings action ("save daily", "save weekly") with
 * completions recorded as deposit-like timestamps. Periods are bucketed by
 * the viewer's local calendar, and weeks start on Monday, matching
 * `lib/streaks.ts`.
 */

export type HabitFrequency = "daily" | "weekly";

export interface HabitDefinition {
  id: string;
  name: string;
  frequency: HabitFrequency;
  /** Local hour (0–23) to send a reminder, or `null` for none. */
  reminderHour?: number | null;
}

export interface CalendarDay {
  /** Local date as `YYYY-MM-DD`. */
  date: string;
  completed: boolean;
}

/** Number of recent periods (days or weeks) used for the strength score. */
export const STRENGTH_WINDOW: Record<HabitFrequency, number> = {
  daily: 28,
  weekly: 4,
};

export const HABIT_TIPS: readonly string[] = [
  "Pick a fixed time each day or week and tie the saving to an existing routine.",
  "Start small. A habit you keep beats a large amount you skip.",
  "Automate the transfer on payday so you do not have to remember.",
  "Missing one period is fine. Aim to get back on track the next period.",
  "Celebrate streaks and watch your strength score climb over time.",
];

const MS_PER_DAY = 86_400_000;

/** Whole local-calendar day number (DST-safe). 1970-01-01 is day 0. */
function dayNumber(date: Date): number {
  return Math.round(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY,
  );
}

/** Period index: the day for daily habits, the Monday-based week for weekly ones. */
function periodOf(date: Date, frequency: HabitFrequency): number {
  const day = dayNumber(date);
  // Day 0 was a Thursday, so (day + 3) / 7 buckets Monday-to-Sunday weeks.
  return frequency === "daily" ? day : Math.floor((day + 3) / 7);
}

/** Local `YYYY-MM-DD` key for a date. */
export function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Day-by-day completion calendar for the last `days` local days ending at
 * `today`, oldest first.
 */
export function buildCompletionCalendar(
  completions: readonly Date[],
  days: number,
  today: Date,
): CalendarDay[] {
  const done = new Set(completions.map(localDateKey));
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const calendar: CalendarDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(end);
    day.setDate(end.getDate() - i);
    const key = localDateKey(day);
    calendar.push({ date: key, completed: done.has(key) });
  }
  return calendar;
}

/**
 * Strength score from 0 to 100: the share of the last `STRENGTH_WINDOW`
 * periods (including the current one) that have at least one completion.
 * Completions dated after `today` are ignored.
 */
export function habitStrength(
  completions: readonly Date[],
  frequency: HabitFrequency,
  today: Date,
): number {
  const window = STRENGTH_WINDOW[frequency];
  const current = periodOf(today, frequency);
  const hits = new Set<number>();
  for (const c of completions) {
    const p = periodOf(c, frequency);
    if (p <= current && p > current - window) hits.add(p);
  }
  return Math.round((hits.size / window) * 100);
}

/**
 * Next time a reminder should fire for `habit`, or `null` if reminders are
 * off. Reminders go out at `reminderHour` on the next day (daily) or on the
 * next Monday (weekly) whose period has no completion yet. Searches at most
 * ~60 periods ahead.
 */
export function nextReminderTime(
  habit: HabitDefinition,
  completions: readonly Date[],
  now: Date,
): Date | null {
  const hour = habit.reminderHour;
  if (hour === null || hour === undefined || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return null;
  }
  const done = new Set(completions.map((c) => periodOf(c, habit.frequency)));
  const stepDays = habit.frequency === "weekly" ? 7 : 1;

  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (habit.frequency === "weekly") {
    // Start from this week's Monday.
    cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
  }

  for (let i = 0; i < 60; i++) {
    const candidate = new Date(cursor);
    candidate.setHours(hour, 0, 0, 0);
    if (candidate.getTime() > now.getTime() && !done.has(periodOf(candidate, habit.frequency))) {
      return candidate;
    }
    cursor.setDate(cursor.getDate() + stepDays);
  }
  return null;
}
