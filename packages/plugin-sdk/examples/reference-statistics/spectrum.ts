import {
  decimal,
  maxU64,
  positive,
  record,
  seriesIdentifier,
} from "./sample-input.ts";

const maxSlots = 4096;
const maxWindows = 32;
const sizes = [8, 16, 32, 64, 128, 256, 512] as const;
type Window = "rectangular" | "hann";

function count(value: unknown, min: number, max: number, path: string) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(path + " must be between " + min + " and " + max);
  return value;
}

function readGrid(
  samples: unknown,
  first: bigint,
  slots: number,
  signal: AbortSignal,
) {
  if (!Array.isArray(samples) || samples.length > slots)
    throw new Error("samples must fit the declared sample grid");
  const grid: (number | undefined)[] = Array.from({ length: slots });
  for (const [index, value] of samples.entries()) {
    signal.throwIfAborted();
    const path = "samples[" + index + "]";
    const sample = record(value, path);
    const position = positive(sample.position, path + ".position");
    const offset = position - first;
    if (
      offset < 0n ||
      offset >= BigInt(slots) ||
      grid[Number(offset)] !== undefined
    )
      throw new Error(path + ".position is outside the grid or duplicated");
    grid[Number(offset)] = Number(decimal(sample.value, path + ".value"));
  }
  return grid;
}

function frequencyBins(
  values: readonly number[],
  weights: readonly number[],
  weightSum: number,
  detrend: boolean,
) {
  const size = values.length;
  const scale = Math.max(...values.map(Math.abs));
  if (!scale) return Array<null>(size / 2 + 1).fill(null);
  const normalized = values.map((value) => value / scale);
  const average = detrend
    ? normalized.reduce((sum, value) => sum + value, 0) / size
    : 0;
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let index = 0, reversed = 0; index < size; index += 1) {
    real[reversed] = (normalized[index]! - average) * weights[index]!;
    // Advance the next bit-reversed index by propagating the carry from the high bit.
    let bit = size >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
  }
  for (let width = 2; width <= size; width *= 2) {
    const half = width / 2;
    for (let offset = 0; offset < half; offset += 1) {
      const angle = (-2 * Math.PI * offset) / width;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      for (let left = offset; left < size; left += width) {
        const right = left + half;
        const re = real[right]! * cosine - imaginary[right]! * sine;
        const im = real[right]! * sine + imaginary[right]! * cosine;
        real[right] = real[left]! - re;
        imaginary[right] = imaginary[left]! - im;
        real[left] = real[left]! + re;
        imaginary[left] = imaginary[left]! + im;
      }
    }
  }
  const scaleDb = 20 * Math.log10(scale);
  return Array.from({ length: size / 2 + 1 }, (_, bin) => {
    const oneSided = bin === 0 || bin === size / 2 ? 1 : 2;
    const amplitude =
      (oneSided * Math.hypot(real[bin]!, imaginary[bin]!)) / weightSum;
    return amplitude ? 20 * Math.log10(amplitude) + scaleDb : null;
  });
}

function weights(size: number, shape: Window) {
  return Array.from({ length: size }, (_, i) =>
    shape === "rectangular"
      ? 1
      : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size),
  );
}

function histogram(values: readonly number[], input: unknown) {
  const config = record(input, "histogram");
  const requestedBins = count(config.bins, 1, 64, "histogram.bins");
  const domain =
    config.domain === undefined
      ? undefined
      : record(config.domain, "histogram.domain");
  if (!domain && !values.length)
    return { requestedBins, bins: [], below: 0, above: 0 };
  const min = domain
    ? Number(decimal(domain.min, "histogram.domain.min"))
    : Math.min(...values);
  const max = domain
    ? Number(decimal(domain.max, "histogram.domain.max"))
    : Math.max(...values);
  if (domain && min >= max)
    throw new Error("histogram.domain.min must be below max");
  if (min === max)
    return {
      requestedBins,
      bins: [{ from: min, to: max, count: values.length }],
      below: 0,
      above: 0,
    };

  const opposite = min < 0 && max > 0;
  const edges = Array.from({ length: requestedBins + 1 }, (_, i) => {
    if (i === 0) return min;
    if (i === requestedBins) return max;
    const ratio = i / requestedBins;
    return opposite
      ? min * (1 - ratio) + max * ratio
      : min + (max - min) * ratio;
  }).filter((edge, i, edges) => i === 0 || edge > edges[i - 1]!);
  const bins = edges
    .slice(1)
    .map((to, i) => ({ from: edges[i]!, to, count: 0 }));
  let below = 0;
  let above = 0;
  for (const value of values) {
    if (value < min) {
      below += 1;
    } else if (value > max) {
      above += 1;
    } else {
      const bin = bins.find(({ to }) => value < to) ?? bins.at(-1)!;
      bin.count += 1;
    }
  }
  return { requestedBins, bins, below, above };
}

function readOptions(source: Record<string, unknown>) {
  const window = record(source.window, "window");
  const size = sizes.find((size) => size === window.size);
  if (size === undefined)
    throw new Error("window.size must be a power of two from 8 to 512");
  const hop = count(window.hop, 1, size, "window.hop");
  const { shape, detrend, missing } = window;
  if (shape !== "rectangular" && shape !== "hann")
    throw new Error("window.shape must be rectangular or hann");
  if (detrend !== "none" && detrend !== "mean")
    throw new Error("window.detrend must be none or mean");
  if (missing !== "skip" && missing !== "zero")
    throw new Error("window.missing must be skip or zero");
  return { size, hop, shape, detrend, missing } as const;
}

export function spectrum(input: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  const source = record(input, "params");
  const first = positive(source.firstPosition, "firstPosition");
  const slots = count(source.expectedSlots, 1, maxSlots, "expectedSlots");
  const period = positive(source.periodNs, "periodNs");
  if (first + BigInt(slots) > maxU64 || period * BigInt(slots) > maxU64)
    throw new Error("The declared grid exceeds u64");
  const clockId = seriesIdentifier(source.clockId, "clockId");
  const unit = source.unit;
  if (unit !== undefined && (typeof unit !== "string" || unit.length > 32))
    throw new Error("unit must be a string of at most 32 characters");
  const window = readOptions(source);
  const windowCount = Math.max(
    0,
    Math.floor((slots - window.size) / window.hop) + 1,
  );
  if (windowCount > maxWindows)
    throw new Error(
      "The declared grid and hop would produce more than " +
        maxWindows +
        " windows",
    );
  const grid = readGrid(source.samples, first, slots, signal);
  const actual = grid.filter((value): value is number => value !== undefined);
  const coefficients = weights(window.size, window.shape);
  const weightSum = coefficients.reduce((sum, value) => sum + value, 0);
  const sampleRateHz = 1_000_000_000 / Number(period);
  const binWidthHz = sampleRateHz / window.size;
  const frequenciesHz = Array.from(
    { length: window.size / 2 + 1 },
    (_, i) => i * binWidthHz,
  );
  const windows = Array.from({ length: windowCount }, (_, i) => {
    signal.throwIfAborted();
    const offset = i * window.hop;
    const samples = grid.slice(offset, offset + window.size);
    const missingCount = samples.filter((value) => value === undefined).length;
    const status =
      missingCount === window.size
        ? "empty"
        : missingCount && window.missing === "skip"
          ? "skipped"
          : missingCount
            ? "zero_filled"
            : "complete";
    const amplitudeDb =
      status !== "empty" && status !== "skipped"
        ? frequencyBins(
            samples.map((value) => value ?? 0),
            coefficients,
            weightSum,
            window.detrend === "mean",
          )
        : null;
    const peakBin =
      amplitudeDb?.reduce<number | null>(
        (best, value, bin) =>
          value !== null && (best === null || value > amplitudeDb[best]!)
            ? bin
            : best,
        null,
      ) ?? null;
    return {
      fromPosition: String(first + BigInt(offset)),
      toPosition: String(first + BigInt(offset + window.size)),
      fromOffsetNs: String(BigInt(offset) * period),
      toOffsetNs: String(BigInt(offset + window.size) * period),
      missingCount,
      status,
      amplitudeDb,
      peakBin,
    };
  });
  const analyzedThrough = windowCount
    ? (windowCount - 1) * window.hop + window.size
    : 0;
  return {
    clockId,
    ...(unit !== undefined ? { unit } : {}),
    firstPosition: String(first),
    expectedSlots: slots,
    validCount: actual.length,
    missingCount: slots - actual.length,
    uncoveredTailSlots: slots - analyzedThrough,
    periodNs: String(period),
    sampleRateHz,
    binWidthHz,
    frequenciesHz,
    window,
    windows,
    histogram: histogram(actual, source.histogram),
  };
}
