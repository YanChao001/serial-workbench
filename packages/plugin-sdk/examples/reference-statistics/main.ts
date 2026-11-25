import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";
import { sampleStatistics } from "../reference-chart/sample-statistics.ts";

import { alignXY } from "./align-xy.ts";
import { spectrum } from "./spectrum.ts";
import {
  decimal,
  maxU64,
  positive,
  record,
  seriesIdentifier,
  u64,
} from "./sample-input.ts";

const action = "swb.reference.statistics.windows";
const maxSlots = 8_192;
const maxSamples = 512;
const maxWindows = 128n;
function readWindow(value: unknown) {
  const window = record(value, "window");
  const length = positive(window.length, "window.length");
  const step = positive(window.step, "window.step");
  if (window.kind === "count")
    return { kind: window.kind, period: 1n, length, step } as const;
  if (window.kind !== "time")
    throw new Error("window.kind must be count or time");
  const clockId = seriesIdentifier(window.clockId, "window.clockId");
  return {
    kind: window.kind,
    clockId,
    origin: u64(window.originMonoNs, "window.originMonoNs"),
    period: positive(window.periodNs, "window.periodNs"),
    length,
    step,
  } as const;
}

function readSamples(value: unknown, first: bigint, after: bigint) {
  if (!Array.isArray(value) || value.length > maxSamples)
    throw new Error(`samples must contain at most ${maxSamples} values`);
  const seen = new Set<bigint>();
  return value.map((entry: unknown, index) => {
    const sample = record(entry, `samples[${index}]`);
    const position = u64(sample.position, `samples[${index}].position`);
    if (position < first || position >= after || seen.has(position))
      throw new Error(
        `samples[${index}].position is outside the grid or duplicated`,
      );
    seen.add(position);
    const value =
      typeof sample.value === "number" && Number.isSafeInteger(sample.value)
        ? sample.value
        : Number(decimal(sample.value, `samples[${index}].value`));
    return { position, value };
  });
}

export function summarize(input: unknown, signal: AbortSignal) {
  const series = record(input, "params");
  const first = positive(series.firstPosition, "firstPosition");
  const slots = series.expectedSlots;
  if (
    typeof slots !== "number" ||
    !Number.isInteger(slots) ||
    slots < 1 ||
    slots > maxSlots
  )
    throw new Error(`expectedSlots must be between 1 and ${maxSlots}`);
  const after = first + BigInt(slots);
  if (after > maxU64) throw new Error("The sample position range exceeds u64");
  const window = readWindow(series.window);
  const extent = BigInt(slots) * window.period;
  if (window.kind === "time" && window.origin + extent > maxU64)
    throw new Error("The monotonic time range exceeds u64");
  if ((extent - 1n) / window.step + 1n > maxWindows)
    throw new Error(
      `The series and step would produce more than ${maxWindows} windows`,
    );
  const samples = readSamples(series.samples, first, after);
  const position = (point: bigint) =>
    first + (point + window.period - 1n) / window.period;
  const windows = [];
  for (let from = 0n; from < extent; from += window.step) {
    signal.throwIfAborted();
    const requestedEnd = from + window.length;
    const to = requestedEnd < extent ? requestedEnd : extent;
    const fromPosition = position(from);
    const toPosition = position(to);
    const validValues = samples
      .filter(
        ({ position }) => position >= fromPosition && position < toPosition,
      )
      .map(({ value }) => value);
    const statistics = sampleStatistics(validValues, toPosition - fromPosition);
    windows.push({
      fromPosition: String(fromPosition),
      toPosition: String(toPosition),
      ...(window.kind === "time"
        ? {
            fromMonoNs: String(window.origin + from),
            toMonoNs: String(window.origin + to),
          }
        : {}),
      partial: requestedEnd > extent,
      expectedCount: Number(statistics.expectedCount),
      validCount: statistics.validCount,
      missingCount: Number(statistics.missingCount),
      missingRate: statistics.missingRate ?? null,
      metrics: statistics.metrics ?? null,
    });
  }
  return {
    kind: window.kind,
    length: String(window.length),
    step: String(window.step),
    firstPosition: String(first),
    expectedSlots: slots,
    ...(typeof series.unit === "string" ? { unit: series.unit } : {}),
    ...(window.kind === "time"
      ? {
          clockId: window.clockId,
          originMonoNs: String(window.origin),
          periodNs: String(window.period),
        }
      : {}),
    windows,
  };
}

export const register: NodeRegister = (context) => {
  context.actions.register(action, (call, task) => {
    task.signal.throwIfAborted();
    return summarize(call.params, task.signal);
  });
  context.actions.register("swb.reference.statistics.alignXY", (call, task) => {
    task.signal.throwIfAborted();
    return alignXY(call.params, task.signal);
  });
  context.actions.register("swb.reference.statistics.spectrum", (call, task) =>
    spectrum(call.params, task.signal),
  );
  context.contributions.register({
    actions: [],
    queries: [],
    transports: [],
    parsers: [],
    views: [],
    themes: [],
    configuration: [],
  });
  return () => {};
};
