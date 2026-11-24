import { parseU64 } from "@/lib/u64";
import type { FieldReading } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import {
  maxMdf4Samples,
  type Mdf4Snapshot,
} from "../../../packages/plugin-sdk/examples/reference-mdf4/snapshot";
import {
  chartValue,
  sharesChartSegment,
  type FieldChartFrame,
} from "./field-chart-model";
import type { FramingInspection } from "./framing-anomalies-model";

function epochNanoseconds(timestamp: string) {
  const time =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(
      timestamp,
    );
  if (!time) return;
  const milliseconds = Date.parse(time[1] + time[3]!);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
  return (
    BigInt(milliseconds) * 1_000_000n + BigInt((time[2] ?? "").padEnd(9, "0"))
  );
}

export function fieldChartMdf4(
  inspection: FramingInspection,
  entries: readonly FieldChartFrame[],
  start: number,
  fields: readonly FieldReading[],
):
  | { status: "ready"; snapshot: Mdf4Snapshot }
  | { status: "range" | "time" | "field" } {
  if (entries.length === start || entries.length - start > maxMdf4Samples)
    return { status: "range" };

  const first = entries[start]?.source;
  if (!first) return { status: "time" };
  const origin = parseU64(first.endTime.sourceMonoNs);
  const absolute = epochNanoseconds(
    first.endTime.sourceWallTime ?? first.endTime.receivedWallTime,
  );
  if (origin === undefined || absolute === undefined) return { status: "time" };

  const channels: Mdf4Snapshot["channels"] = fields.map(
    ({ id, unit }, index) => ({
      name: `${index === 0 ? "primary" : "paired"}_${id}`,
      type: "float64",
      ...(unit ? { unit } : {}),
    }),
  );
  if (
    channels.some(
      ({ name, unit }) =>
        !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(name) ||
        (unit !== undefined && [...unit].length > 32),
    )
  )
    return { status: "field" };
  const sourceColumns = [
    "frame_index",
    "event_start",
    "event_end",
    "byte_start",
    "byte_end",
    "break_before",
  ];
  const ordinals = inspection.recordOrdinals;
  if (ordinals) sourceColumns.push("first_record", "last_record");
  for (const name of sourceColumns) channels.push({ name, type: "uint64" });

  const samples: Mdf4Snapshot["samples"] = [];
  let previousTime = origin;
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index]!;
    const { source, frame } = entry;
    if (
      !source ||
      source.key !== first.key ||
      source.clock !== first.clock ||
      source.revision !== first.revision
    )
      return { status: "time" };
    const time = parseU64(source.endTime.sourceMonoNs);
    if (time === undefined || time < previousTime) return { status: "time" };
    const elapsedNs = time - origin;
    if (parseU64(String(absolute + elapsedNs)) === undefined)
      return { status: "time" };
    previousTime = time;

    const values = fields.map(({ id }) => {
      const value = chartValue(entry, id);
      return value === undefined ? null : String(value);
    });
    const broken =
      index !== start && !sharesChartSegment(entries[index - 1]!, entry);
    values.push(
      String(index + 1),
      frame.eventStart,
      frame.eventEnd,
      frame.byteStart,
      frame.byteEnd,
      broken ? "1" : "0",
    );
    if (ordinals) {
      values.push(
        ordinals.get(source.spans[0]!.event) ?? null,
        ordinals.get(source.spans.at(-1)!.event) ?? null,
      );
    }
    samples.push({ elapsedNs: String(elapsedNs), values });
  }
  return {
    status: "ready",
    snapshot: { startTimeNs: String(absolute), channels, samples },
  };
}
