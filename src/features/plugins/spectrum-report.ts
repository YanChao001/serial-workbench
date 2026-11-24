import { ContractValidationError } from "@serial-workbench/contracts";
import { parseU64 } from "@/lib/u64";

export const spectrumAction = "swb.reference.statistics.spectrum";

function invalid(): never {
  throw new ContractValidationError("Invalid spectrum report");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid();
  return value;
}

function counter(value: unknown, limit: number) {
  const n = finite(value);
  if (!Number.isInteger(n) || n < 0 || n > limit) invalid();
  return n;
}

function position(value: unknown) {
  if (typeof value !== "string" || parseU64(value) === undefined) invalid();
  return value;
}

function series(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}

export function parseSpectrumReport(value: unknown) {
  const report = object(value);
  const { clockId, unit } = report;
  if (
    typeof clockId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(clockId) ||
    (unit !== undefined && (typeof unit !== "string" || unit.length > 32))
  )
    invalid();
  const sampleRateHz = finite(report.sampleRateHz);
  const frequenciesHz = series(report.frequenciesHz, 257).map(finite);
  if (
    sampleRateHz <= 0 ||
    frequenciesHz.length < 5 ||
    frequenciesHz[0] !== 0 ||
    frequenciesHz.slice(1).some((current, i) => current <= frequenciesHz[i]!)
  )
    invalid();
  const spec = object(report.window);
  const { shape, detrend, missing } = spec;
  if (
    (shape !== "hann" && shape !== "rectangular") ||
    (detrend !== "none" && detrend !== "mean") ||
    (missing !== "skip" && missing !== "zero")
  )
    invalid();
  const size = counter(spec.size, 512);
  const hop = counter(spec.hop, size);
  if (!hop || size / 2 + 1 !== frequenciesHz.length) invalid();
  const windows = series(report.windows, 32).map((entry) => {
    const row = object(entry);
    const { status } = row;
    if (
      status !== "empty" &&
      status !== "skipped" &&
      status !== "complete" &&
      status !== "zero_filled"
    )
      invalid();
    const missingCount = counter(row.missingCount, size);
    const amplitudeDb =
      row.amplitudeDb === null
        ? null
        : series(row.amplitudeDb, 257).map((value) =>
            value === null ? null : finite(value),
          );
    const peakBin =
      row.peakBin === null
        ? null
        : counter(row.peakBin, frequenciesHz.length - 1);
    if (
      (status === "empty" || status === "skipped") !== (amplitudeDb === null) ||
      (amplitudeDb && amplitudeDb.length !== frequenciesHz.length) ||
      (peakBin !== null && amplitudeDb?.[peakBin] == null)
    )
      invalid();
    return {
      status,
      amplitudeDb,
      peakBin,
      missingCount,
      fromPosition: position(row.fromPosition),
      toPosition: position(row.toPosition),
      fromOffsetNs: position(row.fromOffsetNs),
      toOffsetNs: position(row.toOffsetNs),
    } as const;
  });
  const expected = counter(report.expectedSlots, 4096);
  const observed = counter(report.validCount, expected);
  const missingSamples = counter(report.missingCount, expected);
  if (!expected || missingSamples + observed !== expected) invalid();
  const histogram = object(report.histogram);
  const below = counter(histogram.below, observed);
  const above = counter(histogram.above, observed);
  const bins = series(histogram.bins, 64).map((entry) => {
    const bin = object(entry);
    const from = finite(bin.from);
    const to = finite(bin.to);
    if (from > to) invalid();
    return { from, to, count: counter(bin.count, observed) };
  });
  if (
    bins.reduce((total, bin) => total + bin.count, below + above) !== observed
  )
    invalid();
  return {
    clockId,
    unit,
    sampleRateHz,
    frequenciesHz,
    periodNs: position(report.periodNs),
    expected,
    observed,
    missingSamples,
    tail: counter(report.uncoveredTailSlots, expected),
    window: { size, hop, shape, detrend, missing } as const,
    windows,
    histogram: { bins, below, above },
  };
}

export type SpectrumReport = ReturnType<typeof parseSpectrumReport>;
