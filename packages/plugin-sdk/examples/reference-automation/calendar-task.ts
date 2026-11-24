import { locks } from "node:worker_threads";
import type { NodeActionHandler } from "@serial-workbench/plugin-sdk/node";
import {
  calendarClock,
  calendarLatenessMs,
  waitForCalendarOccurrence,
  type CalendarClock,
} from "./calendar-clock.ts";
import {
  compileCalendarSchedule,
  parseCalendarInstant,
} from "./calendar-schedule.ts";
import { decodeAutomationFrame } from "./session-response.ts";
import { settledOperation } from "./session-transaction.ts";

import { calendarMaxPlanMs, calendarMaxRuns } from "./calendar-settings.ts";

export { calendarTaskAction } from "./calendar-settings.ts";
const maxRevision = 18_446_744_073_709_551_615n;

type ScheduledWrite = {
  scheduledMs: number;
  observedMs: number;
  operationId: string;
  outcome: "written" | "missed" | "transmit_unconfirmed";
};

export function createCalendarTask(
  clock: CalendarClock = calendarClock,
): NodeActionHandler {
  const run: NodeActionHandler = async ({ target, params }, task) => {
    const { sessionId, sessionEpoch } = target;
    const { sessionRevision } = params;
    if (
      target.kind !== "session" ||
      target.id !== sessionId ||
      !sessionId ||
      !sessionEpoch ||
      typeof sessionRevision !== "string" ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(sessionRevision) ||
      BigInt(sessionRevision) > maxRevision
    )
      throw new Error(
        "Calendar sending requires an exact session and revision",
      );

    const schedule = compileCalendarSchedule(params.schedule);
    const count = params.count ?? 1;
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > calendarMaxRuns ||
      (schedule.kind === "once" && (count !== 1 || params.endAt !== undefined))
    )
      throw new Error("Invalid calendar run limit");

    const end =
      schedule.kind === "once"
        ? schedule.atMs
        : parseCalendarInstant(params.endAt);
    const bytesBase64 = decodeAutomationFrame(params.bytesBase64).toString(
      "base64",
    );
    let cursor = clock.now();
    if (end - cursor > calendarMaxPlanMs)
      throw new Error("Calendar run exceeds 366 days");

    const runs: ScheduledWrite[] = [];
    const skipped: { firstMs: number; throughMs: number }[] = [];
    if (schedule.kind === "once" && end <= cursor)
      return {
        outcome: "missed",
        runs,
        skipped: [{ firstMs: end, throughMs: end }],
      };
    task.progress.report({
      completed: "0",
      total: String(count),
      unit: "slots",
    });

    let skippedWhileWaiting: (typeof skipped)[number] | undefined;
    while (runs.length < count) {
      const occurrence = await waitForCalendarOccurrence(
        schedule,
        cursor,
        end,
        task.signal,
        clock,
      );
      if (occurrence.skipped) {
        skippedWhileWaiting ??= occurrence.skipped;
        skippedWhileWaiting.throughMs = occurrence.skipped.throughMs;
        cursor = occurrence.skipped.throughMs;
      }
      if (occurrence.kind === "no_occurrence") {
        if (skippedWhileWaiting) skipped.push(skippedWhileWaiting);
        const noWrites = runs.every((run) => run.outcome === "missed");
        const hasMisses = skipped.length > 0 || runs.length > 0;
        const outcome = noWrites && hasMisses ? "missed" : "window_ended";
        return { outcome, runs, skipped };
      }

      const { scheduledMs } = occurrence;
      const observedMs = clock.now();
      if (observedMs < scheduledMs) continue;
      if (observedMs - scheduledMs > calendarLatenessMs) {
        skippedWhileWaiting ??= { firstMs: scheduledMs, throughMs: observedMs };
        skippedWhileWaiting.throughMs = Math.min(observedMs, end);
        cursor = observedMs;
        continue;
      }

      task.signal.throwIfAborted();
      if (skippedWhileWaiting) skipped.push(skippedWhileWaiting);
      skippedWhileWaiting = undefined;
      const child = await task.actions.invokeChild({
        actionId: "session.tx",
        target,
        expectedRevision: sessionRevision,
        params: {
          bytesBase64,
          writeWaitMs: "1000",
          dispatchWindow: {
            earliestUnixMs: String(scheduledMs),
            latestUnixMs: String(scheduledMs + calendarLatenessMs),
          },
        },
      });
      const finished = await settledOperation(task, child);
      task.signal.throwIfAborted();
      const receipt = finished?.result;
      const sameWrite =
        receipt?.kind === "tx" &&
        receipt.value.operationId === child.operationId &&
        receipt.value.sessionId === sessionId &&
        receipt.value.sessionEpoch === sessionEpoch &&
        receipt.value.bytesBase64 === bytesBase64;
      const written =
        sameWrite &&
        finished?.state === "succeeded" &&
        receipt.value.outcome === "accepted";
      const missed =
        sameWrite &&
        receipt.value.outcome === "rejected" &&
        receipt.value.backendError?.code === "TX_DISPATCH_WINDOW_MISSED" &&
        receipt.value.acceptedRanges.length === 0 &&
        receipt.value.unknownRanges.length === 0;
      const outcome = missed
        ? "missed"
        : written
          ? "written"
          : "transmit_unconfirmed";
      runs.push({
        scheduledMs,
        observedMs,
        operationId: child.operationId,
        outcome,
      });
      if (outcome === "transmit_unconfirmed") return { outcome, runs, skipped };
      task.progress.report({
        completed: String(runs.length),
        total: String(count),
        unit: "slots",
      });
      cursor = scheduledMs;
    }

    if (runs.every((run) => run.outcome === "missed"))
      return { outcome: "missed", runs, skipped };
    const hasMisses =
      skipped.length > 0 || runs.some((run) => run.outcome === "missed");
    return {
      outcome: hasMisses ? "completed_with_misses" : "completed",
      runs,
      skipped,
    };
  };

  return async (call, task) => {
    for (let slot = 1; slot <= 2; slot++) {
      task.signal.throwIfAborted();
      const result = await locks.request(
        "swb.calendar.slot." + slot,
        { ifAvailable: true },
        (lock) => (lock ? run(call, task) : undefined),
      );
      if (result !== undefined) return result;
    }
    return { outcome: "capacity_reached", runs: [], skipped: [] };
  };
}
