import {
  ContractValidationError,
  type Target,
} from "@serial-workbench/contracts";
import { parseAnalysisInput, readAnalysisReport } from "./analysis-report";
import { parseU64 } from "@/lib/u64";
import type { HostContextValue } from "@/providers/host-context";

export { statisticsPackage } from "./analysis-report";
export const alignXyAction = "swb.reference.statistics.alignXY";
export const maxAnalysisInput = 32768;

type Sample = { index: number; time: string; value: string | null };
type Fraction = { numerator: string; denominator: string };
type Source = { sourceId: string; clockId: string };
type MissingReason =
  "x_missing" | "y_missing" | "outside" | "gap" | "no_exact_match";
type Match =
  | { status: "exact"; sample: Sample }
  | {
      status: "interpolated";
      value: string;
      before: Sample;
      after: Sample;
      fraction: Fraction;
    }
  | {
      status: "missing";
      reason: MissingReason;
      before?: Sample;
      after?: Sample;
    };

function invalidReport(): never {
  throw new ContractValidationError("Invalid cross-source XY report");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidReport();
  return value as Record<string, unknown>;
}

function source(value: unknown): Source {
  const { sourceId, clockId } = object(value);
  const valid = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
  if (
    typeof sourceId !== "string" ||
    typeof clockId !== "string" ||
    !valid.test(sourceId) ||
    !valid.test(clockId)
  )
    invalidReport();
  return { sourceId, clockId };
}

function decimal(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) ||
    !Number.isFinite(Number(value))
  )
    invalidReport();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || parseU64(value) === undefined)
    invalidReport();
  return value;
}

function sample(value: unknown): Sample {
  const point = object(value);
  if (
    typeof point.index !== "number" ||
    !Number.isInteger(point.index) ||
    point.index < 0 ||
    point.index > 127
  )
    invalidReport();
  return {
    index: point.index,
    time: timestamp(point.monoNs),
    value: point.value === null ? null : decimal(point.value),
  };
}

function fraction(value: unknown): Fraction {
  const { numerator, denominator } = object(value);
  const valid = /^[1-9]\d{0,38}$/;
  if (
    typeof numerator !== "string" ||
    !valid.test(numerator) ||
    typeof denominator !== "string" ||
    !valid.test(denominator)
  )
    invalidReport();
  return { numerator, denominator };
}

function match(value: unknown): Match {
  const entry = object(value);
  if (entry.status === "exact") {
    const right = sample(entry.sample);
    if (right.value === null) invalidReport();
    return { status: "exact", sample: right };
  }
  if (entry.status === "interpolated") {
    const before = sample(entry.before);
    const after = sample(entry.after);
    const weight = fraction(entry.fraction);
    if (
      before.value === null ||
      after.value === null ||
      before.index >= after.index ||
      BigInt(before.time) >= BigInt(after.time) ||
      BigInt(weight.numerator) >= BigInt(weight.denominator)
    )
      invalidReport();
    return {
      status: "interpolated",
      before,
      after,
      value: decimal(entry.value),
      fraction: weight,
    };
  }
  const { reason } = entry;
  if (
    entry.status !== "missing" ||
    (reason !== "x_missing" &&
      reason !== "y_missing" &&
      reason !== "outside" &&
      reason !== "gap" &&
      reason !== "no_exact_match")
  )
    invalidReport();
  return {
    status: "missing",
    reason,
    before: entry.before === undefined ? undefined : sample(entry.before),
    after: entry.after === undefined ? undefined : sample(entry.after),
  };
}

export function parseXyReport(value: unknown) {
  const data = object(value);
  if (
    !Array.isArray(data.pairs) ||
    data.pairs.length > 128 ||
    !Array.isArray(data.anchors) ||
    data.anchors.length > 2
  )
    invalidReport();
  const pairs = data.pairs.map((value: unknown, index) => {
    const pair = object(value);
    const x = sample(pair.x);
    const y = match(pair.y);
    if (
      x.index !== index ||
      typeof pair.breakBefore !== "boolean" ||
      (x.value === null && y.status !== "missing")
    )
      invalidReport();
    return { x, y, breakBefore: pair.breakBefore };
  });
  const anchors = data.anchors.map((value: unknown) => {
    const anchor = object(value);
    return { x: timestamp(anchor.xMonoNs), y: timestamp(anchor.yMonoNs) };
  });
  return {
    x: source(data.x),
    y: source(data.y),
    clockRate: fraction(data.clockRate),
    anchors,
    pairs,
  };
}

export type XyReport = ReturnType<typeof parseXyReport>;
export type XyPair = XyReport["pairs"][number];

export function parseXyInput(text: string) {
  return parseAnalysisInput(text, maxAnalysisInput);
}

export async function runXyAnalysis(
  host: Pick<HostContextValue, "invoke" | "waitForOperation" | "readFile">,
  target: Target,
  archiveSha256: string,
  params: NonNullable<ReturnType<typeof parseXyInput>>,
  signal: AbortSignal,
) {
  return parseXyReport(
    await readAnalysisReport(
      host,
      target,
      archiveSha256,
      alignXyAction,
      params,
      signal,
    ),
  );
}
