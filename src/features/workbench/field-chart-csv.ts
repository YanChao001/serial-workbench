import {
  csvCell,
  spreadsheetText,
} from "../../../packages/plugin-sdk/examples/reference-chart/csv";
import type { FieldReading } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import {
  chartValue,
  fieldChartSpans,
  sharesChartSegment,
  type FieldChartFrame,
} from "./field-chart-model";
import type { FramingInspection } from "./framing-anomalies-model";

export type FieldChartMode = "trace" | "xy" | "scatter";

const readingColumns = [
  "field",
  "value",
  "unit",
  "raw_value",
  "calibration_revision",
  "source_spans",
];

const header = [
  "frame_index",
  "chart_mode",
  "continuity",
  "missing_frames_before",
  "point_valid",
  "host_id",
  "instance_epoch",
  "session_id",
  "session_epoch",
  "configuration_revision",
  "clock_id",
  "event_start",
  "event_end",
  "byte_start",
  "byte_end",
  ...readingColumns.map((column) => "primary_" + column),
  ...readingColumns.map((column) => "paired_" + column),
];

function knownMissing(
  previous: FieldChartFrame,
  entry: FieldChartFrame,
  frameWidth: number | undefined,
) {
  const left = previous.source;
  const right = entry.source;
  if (
    !frameWidth ||
    !left ||
    !right ||
    left.key !== right.key ||
    left.revision !== right.revision ||
    left.clock !== right.clock
  )
    return;
  const gap = BigInt(entry.frame.byteStart) - BigInt(previous.frame.byteEnd);
  const width = BigInt(frameWidth);
  if (gap > 0n && gap % width === 0n) return String(gap / width);
}

function readingCells(
  entry: FieldChartFrame,
  field: FieldReading | undefined,
  recordOrdinals: FramingInspection["recordOrdinals"],
) {
  const reading = field && entry.readings?.find(({ id }) => id === field.id);
  const value =
    reading && chartValue(entry, reading.id) !== undefined
      ? reading.value
      : undefined;
  const spans =
    reading &&
    fieldChartSpans(entry, reading).map((span) => ({
      ...span,
      record: recordOrdinals?.get(span.event),
    }));
  return {
    valid: value !== undefined,
    cells: [
      spreadsheetText(field?.id),
      value,
      spreadsheetText(field?.unit),
      entry.source ? reading?.rawValue : undefined,
      entry.source
        ? spreadsheetText(reading?.calibration?.revision)
        : undefined,
      spans?.length ? JSON.stringify(spans) : undefined,
    ],
  };
}

export function fieldChartCsv({
  inspection,
  entries,
  start,
  mode,
  primary,
  paired,
}: {
  inspection: FramingInspection;
  entries: readonly FieldChartFrame[];
  start: number;
  mode: FieldChartMode;
  primary: FieldReading;
  paired?: FieldReading;
}) {
  const { target, recordOrdinals, fixedFrameWidth } = inspection;
  const rows = [header.join(",")];
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index]!;
    const previous = index === start ? undefined : entries[index - 1];
    const continuous = previous && sharesChartSegment(previous, entry);
    const missing = continuous
      ? "0"
      : previous && knownMissing(previous, entry, fixedFrameWidth);
    const first = readingCells(entry, primary, recordOrdinals);
    const second = readingCells(entry, paired, recordOrdinals);
    const { frame, source } = entry;
    rows.push(
      [
        String(index + 1),
        mode,
        previous ? (continuous ? "continuous" : "gap") : "start",
        missing,
        String(first.valid && (!paired || second.valid)),
        spreadsheetText(source && target.hostId),
        source?.instance,
        spreadsheetText(source && target.sessionId),
        source && target.sessionEpoch,
        source?.revision,
        spreadsheetText(source?.clock),
        source && frame.eventStart,
        source && frame.eventEnd,
        source && frame.byteStart,
        source && frame.byteEnd,
        ...first.cells,
        ...second.cells,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return rows.join("\r\n") + "\r\n";
}
