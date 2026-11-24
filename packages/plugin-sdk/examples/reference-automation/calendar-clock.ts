import { setTimeout as delay } from "node:timers/promises";
import type { CalendarSchedule } from "./calendar-schedule.ts";

export type CalendarClock = {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<unknown>;
};

export const calendarClock: CalendarClock = {
  now: () => Date.now(),
  wait: (ms, signal) => delay(ms, undefined, { signal }),
};

const maximumClockCheckMs = 30_000;
export const calendarLatenessMs = 2_000;

type SkippedSlots = { firstMs: number; throughMs: number };
type CalendarOccurrence =
  | {
      kind: "due";
      scheduledMs: number;
      observedMs: number;
      skipped?: SkippedSlots;
    }
  | { kind: "no_occurrence"; skipped?: SkippedSlots };

export async function waitForCalendarOccurrence(
  schedule: CalendarSchedule,
  afterMs: number,
  throughMs: number,
  signal: AbortSignal,
  clock: CalendarClock = calendarClock,
): Promise<CalendarOccurrence> {
  signal.throwIfAborted();
  let scheduledMs = schedule.nextOccurrence(afterMs, throughMs);
  let skipped: SkippedSlots | undefined;

  while (scheduledMs !== undefined) {
    signal.throwIfAborted();
    const now = clock.now();
    const remaining = scheduledMs - now;
    if (remaining > 0) {
      await clock.wait(Math.min(remaining, maximumClockCheckMs), signal);
      continue;
    }
    if (-remaining <= calendarLatenessMs) {
      const occurrence = { kind: "due" as const, scheduledMs, observedMs: now };
      return skipped ? { ...occurrence, skipped } : occurrence;
    }

    skipped = {
      firstMs: skipped?.firstMs ?? scheduledMs,
      throughMs: Math.min(now, throughMs),
    };
    scheduledMs = schedule.nextOccurrence(now, throughMs);
  }
  return skipped
    ? { kind: "no_occurrence", skipped }
    : { kind: "no_occurrence" };
}
