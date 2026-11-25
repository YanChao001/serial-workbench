import { ContractValidationError } from "@serial-workbench/contracts";
import { isRecord } from "@/lib/settings-model";
import { parseU64, U64_MAX } from "@/lib/u64";

export const windowsAction = "swb.reference.statistics.windows";

export const windowMetrics = [
  "minimum",
  "maximum",
  "average",
  "deviation",
  "p50",
  "p95",
  "p99",
] as const;

function invalid(): never {
  throw new ContractValidationError("Invalid statistical windows report");
}

function decimal(value: unknown) {
  const parsed = parseU64(value);
  if (parsed === undefined) invalid();
  return parsed;
}

function counter(value: unknown, limit: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > limit
  )
    invalid();
  return value;
}

function readMetrics(value: unknown) {
  if (!isRecord(value)) invalid();
  return windowMetrics.map((key) => {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number)) invalid();
    return { key, value: number };
  });
}

export function parseWindowsReport(value: unknown) {
  if (!isRecord(value)) invalid();
  const { kind, unit, clockId } = value;
  if (
    (kind !== "count" && kind !== "time") ||
    (unit !== undefined && (typeof unit !== "string" || unit.length > 32)) ||
    !Array.isArray(value.windows) ||
    value.windows.length < 1 ||
    value.windows.length > 128
  )
    invalid();
  const expectedSlots = counter(value.expectedSlots, 8192);
  const firstPosition = decimal(value.firstPosition);
  const afterPosition = firstPosition + BigInt(expectedSlots);
  const length = decimal(value.length);
  const step = decimal(value.step);
  if (
    !expectedSlots ||
    !firstPosition ||
    afterPosition > U64_MAX ||
    !length ||
    !step
  )
    invalid();
  const clock =
    kind === "time"
      ? (() => {
          if (
            typeof clockId !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(clockId)
          )
            invalid();
          const origin = decimal(value.originMonoNs);
          const period = decimal(value.periodNs);
          if (!period || origin + BigInt(expectedSlots) * period > U64_MAX)
            invalid();
          return { id: clockId, origin, period };
        })()
      : undefined;
  const period = clock?.period ?? 1n;
  const extent = BigInt(expectedSlots) * period;
  if (BigInt(value.windows.length) !== (extent - 1n) / step + 1n) invalid();

  const windows = value.windows.map((entry: unknown, index) => {
    if (!isRecord(entry)) invalid();
    const from = BigInt(index) * step;
    const to = from + length < extent ? from + length : extent;
    const fromPosition = decimal(entry.fromPosition);
    const toPosition = decimal(entry.toPosition);
    if (
      fromPosition !== firstPosition + (from + period - 1n) / period ||
      toPosition !== firstPosition + (to + period - 1n) / period ||
      entry.partial !== from + length > extent
    )
      invalid();
    const expectedCount = counter(entry.expectedCount, expectedSlots);
    const validCount = counter(entry.validCount, expectedCount);
    const missingCount = counter(entry.missingCount, expectedCount);
    const missingRate = expectedCount ? missingCount / expectedCount : null;
    if (
      BigInt(expectedCount) !== toPosition - fromPosition ||
      validCount + missingCount !== expectedCount ||
      entry.missingRate !== missingRate ||
      (validCount === 0 && entry.metrics !== null)
    )
      invalid();
    const time = clock
      ? {
          from: decimal(entry.fromMonoNs),
          to: decimal(entry.toMonoNs),
        }
      : undefined;
    if (
      clock &&
      (time?.from !== clock.origin + from || time.to !== clock.origin + to)
    )
      invalid();
    return {
      fromPosition,
      toPosition,
      time,
      validCount,
      missingCount,
      expectedCount,
      missingRate,
      partial: entry.partial === true,
      metrics: validCount ? readMetrics(entry.metrics) : null,
    };
  });
  return {
    kind,
    unit,
    firstPosition,
    afterPosition,
    length,
    step,
    clock,
    windows,
  };
}

export type WindowsReport = ReturnType<typeof parseWindowsReport>;
