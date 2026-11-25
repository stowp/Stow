"use client";

import { useMemo } from "react";
import {
  HABIT_TIPS,
  buildCompletionCalendar,
  habitStrength,
  nextReminderTime,
  type HabitDefinition,
} from "@/lib/savingsHabits";

export interface HabitTrackerProps {
  habit: HabitDefinition;
  /** Dates on which the habit was completed (e.g. a deposit made). */
  completions: readonly Date[];
  /** Days shown in the calendar. */
  days?: number;
  /** Injected for deterministic rendering; defaults to now. */
  today?: Date;
}

export default function HabitTracker({
  habit,
  completions,
  days = 28,
  today,
}: HabitTrackerProps) {
  const now = useMemo(() => today ?? new Date(), [today]);
  const calendar = useMemo(
    () => buildCompletionCalendar(completions, days, now),
    [completions, days, now],
  );
  const strength = habitStrength(completions, habit.frequency, now);
  const reminder = nextReminderTime(habit, completions, now);

  return (
    <section aria-labelledby="habit-heading" className="space-y-4">
      <header className="flex items-baseline justify-between">
        <h3 id="habit-heading" className="font-semibold">
          {habit.name}
        </h3>
        <p className="text-sm">Strength: {strength}/100</p>
      </header>

      <ol
        aria-label={`${habit.name} completion calendar`}
        className="grid grid-cols-7 gap-1"
      >
        {calendar.map((day) => (
          <li
            key={day.date}
            aria-label={`${day.date}: ${day.completed ? "completed" : "not completed"}`}
            className={`h-6 rounded ${day.completed ? "bg-emerald-500" : "bg-gray-200 dark:bg-gray-700"}`}
          />
        ))}
      </ol>

      <p className="text-sm">
        {reminder
          ? `Next reminder: ${reminder.toLocaleString()}`
          : "Reminders are off for this habit."}
      </p>

      <div>
        <h4 className="text-sm font-medium">Tips</h4>
        <ul className="list-disc pl-5 text-sm">
          {HABIT_TIPS.slice(0, 3).map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
