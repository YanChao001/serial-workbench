import assert from "node:assert/strict";
import test from "node:test";
import { waitForCalendarOccurrence } from "../packages/plugin-sdk/examples/reference-automation/calendar-clock.ts";
import { compileCalendarSchedule } from "../packages/plugin-sdk/examples/reference-automation/calendar-schedule.ts";

const start = Date.parse("2026-11-24T03:00:00Z");
const minute = 60_000;
const cron = compileCalendarSchedule({
  kind: "cron",
  expression: "* * * * *",
  timeZone: "UTC",
});

test("a simulated resume skips overdue slots instead of issuing a catch-up trigger", async () => {
  let now = start;
  const waits = [];
  const clock = {
    now: () => now,
    async wait(ms) {
      waits.push(ms);
      now += waits.length === 1 ? 2 * minute + 5_000 : ms;
    },
  };
  const result = await waitForCalendarOccurrence(
    cron,
    start,
    start + 4 * minute,
    new AbortController().signal,
    clock,
  );

  assert.deepEqual(result, {
    kind: "due",
    scheduledMs: start + 3 * minute,
    observedMs: start + 3 * minute,
    skipped: { firstMs: start + minute, throughMs: start + 2 * minute + 5_000 },
  });
  assert.ok(waits.every((ms) => ms > 0 && ms <= 30_000));
});

test("an expired one-time schedule returns a skipped slot and never becomes due", async () => {
  let now = start;
  const scheduled = start + minute;
  const once = compileCalendarSchedule({
    kind: "once",
    at: new Date(scheduled).toISOString(),
  });
  const result = await waitForCalendarOccurrence(
    once,
    start,
    scheduled,
    new AbortController().signal,
    {
      now: () => now,
      async wait() {
        now = scheduled + 5_000;
      },
    },
  );

  assert.deepEqual(result, {
    kind: "no_occurrence",
    skipped: { firstMs: scheduled, throughMs: scheduled },
  });
});

test("an abort before the clock reaches a slot prevents dispatch", async () => {
  const controller = new AbortController();
  const result = waitForCalendarOccurrence(
    cron,
    start,
    start + minute,
    controller.signal,
    {
      now: () => start,
      async wait() {
        controller.abort();
      },
    },
  );
  await assert.rejects(result, { name: "AbortError" });
});

test("wall-clock rollback extends waiting without repeating the cursor's occurrence", async () => {
  let now = start;
  let waits = 0;
  const result = await waitForCalendarOccurrence(
    cron,
    start,
    start + minute,
    new AbortController().signal,
    {
      now: () => now,
      async wait(ms) {
        now += waits++ === 0 ? -15_000 : ms;
      },
    },
  );
  assert.deepEqual(result, {
    kind: "due",
    scheduledMs: start + minute,
    observedMs: start + minute,
  });
});
