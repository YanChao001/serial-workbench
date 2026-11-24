import assert from "node:assert/strict";
import test from "node:test";
import { compileCalendarSchedule } from "../packages/plugin-sdk/examples/reference-automation/calendar-schedule.ts";

test("resolves a one-time schedule at the supplied offset and within Host bounds", () => {
  const schedule = compileCalendarSchedule({
    kind: "once",
    at: "2026-11-24T09:30:00.125+08:00",
  });
  const scheduled = Date.parse("2026-11-24T01:30:00.125Z");

  assert.equal(schedule.nextOccurrence(scheduled - 1, scheduled), scheduled);
  assert.equal(
    schedule.nextOccurrence(scheduled - 2, scheduled - 1),
    undefined,
  );
  assert.equal(schedule.nextOccurrence(scheduled, scheduled + 1), undefined);
  assert.throws(
    () => compileCalendarSchedule({ kind: "once", at: "2026-11-24T09:30:00" }),
    /offset/i,
  );
  assert.throws(
    () => compileCalendarSchedule({ kind: "once", at: "2026-02-31T09:30:00Z" }),
    /real date/i,
  );
});

test("resolves five-field cron lists, steps, aliases and day matching in the selected zone", () => {
  const schedule = compileCalendarSchedule({
    kind: "cron",
    expression: "15,45 8-10/2 * * MON-FRI",
    timeZone: "Asia/Shanghai",
  });
  const monday = Date.parse("2026-11-23T00:15:00Z");
  assert.equal(
    schedule.nextOccurrence(Date.parse("2026-11-20T02:45:00Z"), monday),
    monday,
  );

  const daySchedule = compileCalendarSchedule({
    kind: "cron",
    expression: "0 12 13 NOV MON",
    timeZone: "UTC",
  });
  const friday = Date.parse("2026-11-13T12:00:00Z");
  const followingMonday = Date.parse("2026-11-16T12:00:00Z");
  assert.equal(daySchedule.nextOccurrence(friday - 1, friday), friday);
  assert.equal(
    daySchedule.nextOccurrence(friday, followingMonday),
    followingMonday,
  );
});

test("skips nonexistent local times and uses only the earlier instant of a repeated time", () => {
  const spring = compileCalendarSchedule({
    kind: "cron",
    expression: "30 2 * * *",
    timeZone: "America/New_York",
  });
  const march9 = Date.parse("2026-03-09T06:30:00Z");
  assert.equal(
    spring.nextOccurrence(Date.parse("2026-03-07T07:30:00Z"), march9),
    march9,
  );

  const fall = compileCalendarSchedule({
    kind: "cron",
    expression: "30 1 * * *",
    timeZone: "America/New_York",
  });
  const earlier = Date.parse("2026-11-01T05:30:00Z");
  const later = Date.parse("2026-11-01T06:30:00Z");
  assert.equal(fall.nextOccurrence(earlier - 1, later), earlier);
  assert.equal(fall.nextOccurrence(earlier, later), undefined);
});

test("rejects cron expressions and zones that cannot describe a supported schedule", () => {
  for (const expression of [
    "60 0 * * *",
    "1-SUN 0 * * *",
    "*/0 0 * * *",
    "0 0 * * FRI-MON",
    "0 0 * *",
  ]) {
    assert.throws(
      () =>
        compileCalendarSchedule({ kind: "cron", expression, timeZone: "UTC" }),
      /five fields|invalid cron/i,
    );
  }
  assert.throws(
    () =>
      compileCalendarSchedule({
        kind: "cron",
        expression: "0 0 * * 7",
        timeZone: "+08:00",
      }),
    /time zone/i,
  );
});
