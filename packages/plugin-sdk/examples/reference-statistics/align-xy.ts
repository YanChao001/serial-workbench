import {
  decimal,
  positive,
  record,
  seriesIdentifier,
  u64,
} from "./sample-input.ts";

const maxSamples = 128;

type Sample = {
  index: number;
  monoNs: bigint;
  value: string | null;
  gapBefore: boolean;
};

function readSeries(input: unknown, axis: "x" | "y") {
  const series = record(input, axis);
  const sourceId = seriesIdentifier(series.sourceId, axis + ".sourceId");
  const clockId = seriesIdentifier(series.clockId, axis + ".clockId");
  if (!Array.isArray(series.samples) || series.samples.length > maxSamples)
    throw new Error(
      axis + ".samples must contain at most " + maxSamples + " points",
    );
  let previous = -1n;
  const samples = series.samples.map((entry: unknown, index): Sample => {
    const path = axis + ".samples[" + index + "]";
    const sample = record(entry, path);
    const monoNs = u64(sample.monoNs, path + ".monoNs");
    if (monoNs < previous)
      throw new Error(path + ".monoNs must not go backwards");
    previous = monoNs;
    const value =
      sample.value === null ? null : decimal(sample.value, path + ".value");
    if (sample.gapBefore !== undefined && typeof sample.gapBefore !== "boolean")
      throw new Error(path + ".gapBefore must be a boolean");
    return { index, monoNs, value, gapBefore: sample.gapBefore === true };
  });
  return { sourceId, clockId, samples };
}

function readAnchor(input: unknown, path: string) {
  const anchor = record(input, path);
  return {
    xMonoNs: u64(anchor.xMonoNs, path + ".xMonoNs"),
    yMonoNs: u64(anchor.yMonoNs, path + ".yMonoNs"),
  };
}

function readAlignment(input: unknown, sameClock: boolean) {
  if (sameClock) {
    if (input !== undefined)
      throw new Error("anchors must be omitted for a shared clock");
    return {
      xOrigin: 0n,
      yOrigin: 0n,
      numerator: 1n,
      denominator: 1n,
      anchors: [],
    };
  }
  if (!Array.isArray(input) || input.length < 1 || input.length > 2)
    throw new Error("distinct clocks require one or two paired anchors");
  const first = readAnchor(input[0], "anchors[0]");
  const second =
    input.length === 2 ? readAnchor(input[1], "anchors[1]") : undefined;
  const xOrigin = first.xMonoNs;
  const yOrigin = first.yMonoNs;
  const numerator = second ? second.xMonoNs - xOrigin : 1n;
  const denominator = second ? second.yMonoNs - yOrigin : 1n;
  if (numerator <= 0n || denominator <= 0n)
    throw new Error("paired anchors must advance on both clocks");
  return {
    xOrigin,
    yOrigin,
    numerator,
    denominator,
    anchors: (second ? [first, second] : [first]).map(
      ({ xMonoNs, yMonoNs }) => ({
        xMonoNs: String(xMonoNs),
        yMonoNs: String(yMonoNs),
      }),
    ),
  };
}

function sourceSample(sample: Sample) {
  return {
    index: sample.index,
    monoNs: String(sample.monoNs),
    value: sample.value,
  };
}

function interpolate(
  left: string,
  right: string,
  numerator: bigint,
  denominator: bigint,
) {
  const start = Number(left);
  const end = Number(right);
  const fraction = Number(numerator) / Number(denominator);
  // Weighted addition avoids overflowing the difference across opposite signs.
  const sameSign = start < 0 === end < 0;
  const result = sameSign
    ? start + (end - start) * fraction
    : start * (1 - fraction) + end * fraction;
  return String(result);
}

type TimedSample = Sample & {
  ticks: bigint;
  segment: number;
  ambiguous: boolean;
};
type SourceSample = ReturnType<typeof sourceSample>;
type MissingReason =
  | "x_missing"
  | "y_missing"
  | "outside"
  | "gap"
  | "no_exact_match"
  | "ambiguous_y_time";
type SampleMatch =
  | {
      segment: number;
      result:
        | { status: "exact"; sample: SourceSample }
        | {
            status: "interpolated";
            before: SourceSample;
            after: SourceSample;
            value: string;
            fraction: { numerator: string; denominator: string };
          };
    }
  | {
      segment: undefined;
      result: {
        status: "missing";
        reason: MissingReason;
        before?: SourceSample;
        after?: SourceSample;
      };
    };

function matchSample(
  sample: Sample,
  ticks: bigint,
  before: TimedSample | undefined,
  after: TimedSample | undefined,
  next: TimedSample | undefined,
  method: "exact" | "linear",
): SampleMatch {
  const missing = (
    reason: MissingReason,
    lower = before,
    upper = after,
  ): SampleMatch => ({
    segment: undefined,
    result: {
      status: "missing" as const,
      reason,
      ...(lower ? { before: sourceSample(lower) } : {}),
      ...(upper ? { after: sourceSample(upper) } : {}),
    },
  });
  if (sample.value === null) return missing("x_missing");
  if (after?.ticks === ticks) {
    if (after.ambiguous) return missing("ambiguous_y_time", after, next);
    if (after.value === null) return missing("y_missing");
    return {
      segment: after.segment,
      result: { status: "exact" as const, sample: sourceSample(after) },
    };
  }
  if (!before || !after) return missing("outside");
  if (method === "exact") return missing("no_exact_match");
  if (before.ambiguous || after.ambiguous) return missing("ambiguous_y_time");
  if (
    before.segment !== after.segment ||
    before.value === null ||
    after.value === null
  )
    return missing("gap");
  const numerator = ticks - before.ticks;
  const denominator = after.ticks - before.ticks;
  return {
    segment: after.segment,
    result: {
      status: "interpolated" as const,
      before: sourceSample(before),
      after: sourceSample(after),
      value: interpolate(before.value, after.value, numerator, denominator),
      fraction: {
        numerator: String(numerator),
        denominator: String(denominator),
      },
    },
  };
}

export function alignXY(input: unknown, signal: AbortSignal) {
  const params = record(input, "params");
  const { method } = params;
  if (method !== "exact" && method !== "linear")
    throw new Error("method must be exact or linear");
  const x = readSeries(params.x, "x");
  const y = readSeries(params.y, "y");
  const maxGapNs = positive(params.maxGapNs, "maxGapNs");
  const { xOrigin, yOrigin, numerator, denominator, anchors } = readAlignment(
    params.anchors,
    x.clockId === y.clockId,
  );
  const maxGapTicks = maxGapNs * denominator;
  let segment = 0;
  let previous: TimedSample | undefined;
  const timed = y.samples.map((sample, index): TimedSample => {
    const ticks = (sample.monoNs - yOrigin) * numerator;
    const ambiguous =
      y.samples[index - 1]?.monoNs === sample.monoNs ||
      y.samples[index + 1]?.monoNs === sample.monoNs;
    if (
      previous &&
      (sample.gapBefore ||
        ambiguous ||
        previous.ambiguous ||
        sample.value === null ||
        previous.value === null ||
        ticks - previous.ticks > maxGapTicks)
    )
      segment += 1;
    previous = { ...sample, ticks, segment, ambiguous };
    return previous;
  });
  let ahead = 0;
  let previousSegment: number | undefined;
  const pairs = x.samples.map((sample, index) => {
    signal.throwIfAborted();
    const ticks = (sample.monoNs - xOrigin) * denominator;
    let after = timed[ahead];
    while (after && after.ticks < ticks) {
      ahead += 1;
      after = timed[ahead];
    }
    const match = matchSample(
      sample,
      ticks,
      timed[ahead - 1],
      after,
      timed[ahead + 1],
      method,
    );
    const breakBefore =
      sample.gapBefore ||
      (index > 0 &&
        (match.segment === undefined || previousSegment !== match.segment));
    previousSegment = match.segment;
    return { x: sourceSample(sample), y: match.result, breakBefore };
  });
  return {
    x: { sourceId: x.sourceId, clockId: x.clockId },
    y: { sourceId: y.sourceId, clockId: y.clockId },
    method,
    maxGapNs: String(maxGapNs),
    clockRate: {
      numerator: String(numerator),
      denominator: String(denominator),
    },
    anchors,
    pairs,
  };
}
