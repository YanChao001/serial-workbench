import { useId, useState, type FormEvent } from "react";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { parseU64 } from "@/lib/u64";
import { useI18n } from "@/providers/i18n";
import {
  compileProtocolFieldDocument,
  type FieldDefinitionFormat,
} from "../../../packages/plugin-sdk/examples/reference-framing/protocol-field-document";
import { ProtocolFieldError } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import type { FramingInspection } from "./framing-anomalies-model";
import type { FramingFrame } from "./framing-model";
import {
  chartValue,
  fieldChartSelection,
  fieldChartFrames,
  fieldChartSpans,
  isChartField,
  locateChartSelection,
  sharesChartSegment,
  type FieldChartFrame,
} from "./field-chart-model";
import type { ChartSourceSelection } from "./stream-chart-selection";

type Point = { index: number; value: number };
type Plot = {
  source: FramingInspection;
  definition: string;
  format: FieldDefinitionFormat;
  entries?: FieldChartFrame[];
  error?: string;
  selectionUnavailable?: boolean;
};

function compactSegment(segment: Point[]) {
  if (segment.length <= 32) return segment;
  const size = Math.ceil((segment.length - 2) / 15);
  const visible = [segment[0]!];
  for (let start = 1; start < segment.length - 1; start += size) {
    const bucket = segment.slice(
      start,
      Math.min(start + size, segment.length - 1),
    );
    let low = bucket[0]!;
    let high = low;
    for (const point of bucket) {
      if (point.value < low.value) low = point;
      if (point.value > high.value) high = point;
    }
    if (low.index > high.index) visible.push(high, low);
    else if (low !== high) visible.push(low, high);
    else visible.push(low);
  }
  visible.push(segment.at(-1)!);
  return visible;
}

export function FieldChart({
  inspection,
  definition,
  format,
  frame,
  field,
  selectionLocked = false,
  sourceSelection,
  onRevealSource,
  onSelect,
}: {
  inspection: FramingInspection;
  definition: string;
  format: FieldDefinitionFormat;
  frame?: FramingFrame;
  field?: string;
  selectionLocked?: boolean;
  sourceSelection?: ChartSourceSelection;
  onRevealSource?: (source: ChartSourceSelection) => void;
  onSelect: (entry: FieldChartFrame, field: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [plot, setPlot] = useState<Plot>();
  const [compact, setCompact] = useState(false);
  const [recent, setRecent] = useState(false);
  const [lookup, setLookup] = useState({ event: "", byte: "" });
  const [lookupMissed, setLookupMissed] = useState(false);
  const current =
    plot?.source === inspection &&
    plot.definition === definition &&
    plot.format === format
      ? plot
      : undefined;
  const entries = current?.entries ?? [];
  const fields =
    entries.find((entry) => entry.readings)?.readings?.filter(isChartField) ??
    [];
  const channel = fields.find((reading) => reading.id === field) ?? fields[0];
  const selected = Math.max(
    0,
    entries.findIndex((entry) => entry.frame === frame),
  );
  const recentStart = Math.max(0, entries.length - 32);
  const showRecent = recent && selected >= recentStart;
  const start = showRecent ? recentStart : 0;
  const active = entries[selected];
  const segments: Point[][] = [];
  let segment: Point[] | undefined;
  let minimum = Infinity;
  let maximum = -Infinity;
  if (channel) {
    for (let index = start; index < entries.length; index++) {
      const entry = entries[index]!;
      const value = chartValue(entry, channel.id);
      if (value === undefined) {
        segment = undefined;
        continue;
      }
      if (!segment || !sharesChartSegment(entries[index - 1]!, entry)) {
        segment = [];
        segments.push(segment);
      }
      segment.push({ index, value });
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  const activeReading = active?.readings?.find(
    (reading) => reading.id === channel?.id,
  );
  const activeValue =
    active && channel ? chartValue(active, channel.id) : undefined;
  const spans =
    active && activeReading ? fieldChartSpans(active, activeReading) : [];
  const reveal =
    active && activeReading && onRevealSource
      ? fieldChartSelection(active, activeReading)
      : undefined;
  const x = (index: number) =>
    16 + ((index - start) * 608) / Math.max(entries.length - start - 1, 1);
  const scale = Math.max(Math.abs(minimum), Math.abs(maximum), 1);
  const y = (value: number) =>
    minimum === maximum
      ? 80
      : 144 -
        ((value / scale - minimum / scale) * 128) /
          (maximum / scale - minimum / scale);

  function select(index: number, channelId = channel?.id) {
    const entry = entries[index];
    if (entry && channelId && !selectionLocked) onSelect(entry, channelId);
  }

  function build() {
    const snapshot = { source: inspection, definition, format };
    try {
      const { codec } = compileProtocolFieldDocument(definition, format);
      const nextEntries = fieldChartFrames(inspection, codec);
      const source =
        sourceSelection &&
        locateChartSelection(nextEntries, sourceSelection, field);
      setPlot({
        ...snapshot,
        entries: nextEntries,
        selectionUnavailable: Boolean(sourceSelection && !source),
      });
      if (source && !selectionLocked) {
        onSelect(source.entry, source.field);
        return;
      }
      const initial =
        nextEntries.find((entry) => entry.frame === frame) ?? nextEntries[0];
      const nextFields = nextEntries
        .find((entry) => entry.readings)
        ?.readings?.filter(isChartField);
      const channel =
        nextFields?.find(({ id }) => id === field) ?? nextFields?.[0];
      if (initial && channel && !selectionLocked) onSelect(initial, channel.id);
    } catch (reason) {
      if (!(reason instanceof ProtocolFieldError)) throw reason;
      setPlot({ ...snapshot, error: reason.path });
    }
  }

  function locateSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channel || selectionLocked) return;
    const byte = parseU64(lookup.byte);
    const sequence = parseU64(lookup.event);
    if (byte === undefined || sequence === undefined) return;
    const index = entries.findIndex((entry) => {
      const reading = entry.readings?.find(({ id }) => id === channel.id);
      return (
        reading &&
        fieldChartSpans(entry, reading).some(
          (span) =>
            span.event === String(sequence) &&
            byte >= BigInt(span.start) &&
            byte < BigInt(span.end),
        )
      );
    });
    setLookupMissed(index < 0);
    if (index >= 0) {
      if (index < recentStart) setRecent(false);
      select(index);
    }
  }

  return (
    <details className="rounded-md border px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">
        {t("workbench.fieldChart.title")}
      </summary>
      <section
        aria-label={t("workbench.fieldChart.title")}
        className="mt-3 space-y-3"
      >
        <Button
          type="button"
          variant="outline"
          onClick={build}
          disabled={!definition.trim()}
        >
          {t("workbench.fieldChart.plot")}
        </Button>
        {current?.error ? (
          <p role="alert" className="text-destructive">
            {t("workbench.fields.invalidDefinition", { path: current.error })}
          </p>
        ) : null}
        {current?.selectionUnavailable ? (
          <p className="text-muted-foreground">
            {t("workbench.fieldChart.selectionOutsideFields")}
          </p>
        ) : null}
        {current?.entries && !channel ? (
          <p role="status">{t("workbench.fieldChart.noNumericField")}</p>
        ) : null}
        {channel && active ? (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1">
                <label htmlFor={id + "-channel"}>
                  {t("workbench.fields.name")}
                </label>
                <OptionsSelect
                  id={id + "-channel"}
                  value={channel.id}
                  disabled={selectionLocked}
                  onValueChange={(value) => select(selected, value)}
                  options={fields.map((reading) => ({
                    value: reading.id,
                    label: reading.unit
                      ? `${reading.id} (${reading.unit})`
                      : reading.id,
                  }))}
                />
              </div>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={showRecent}
                  disabled={selectionLocked}
                  onCheckedChange={(value) => {
                    const enabled = value === true;
                    setRecent(enabled);
                    if (enabled && selected < entries.length - 32)
                      select(entries.length - 32);
                  }}
                />
                {t("workbench.fieldChart.recent")}
              </label>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={compact}
                  onCheckedChange={(value) => setCompact(value === true)}
                />
                {t("workbench.fieldChart.compact")}
              </label>
            </div>
            <svg
              role="img"
              aria-label={t("workbench.fieldChart.plotLabel")}
              viewBox="0 0 640 160"
              data-surface="artwork"
              className="w-full rounded border text-primary"
              onPointerDown={(event) => {
                const { left, width } =
                  event.currentTarget.getBoundingClientRect();
                if (!width) return;
                const ratio = Math.max(
                  0,
                  Math.min(
                    1,
                    (((event.clientX - left) * 640) / width - 16) / 608,
                  ),
                );
                select(
                  start + Math.round(ratio * (entries.length - start - 1)),
                );
              }}
            >
              <line
                x1={x(selected)}
                x2={x(selected)}
                y1="4"
                y2="156"
                stroke="currentColor"
                strokeDasharray="3 4"
                opacity="0.65"
              />
              {segments.map((points) => {
                const visible = compact ? compactSegment(points) : points;
                return (
                  <g key={points[0]!.index}>
                    <polyline
                      points={visible
                        .map(({ index, value }) => `${x(index)},${y(value)}`)
                        .join(" ")}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                    {visible.map(({ index, value }) => (
                      <circle
                        key={index}
                        cx={x(index)}
                        cy={y(value)}
                        r="3"
                        fill="currentColor"
                      />
                    ))}
                  </g>
                );
              })}
              {activeValue !== undefined ? (
                <circle
                  cx={x(selected)}
                  cy={y(activeValue)}
                  r="6"
                  fill="currentColor"
                />
              ) : null}
            </svg>
            <label className="grid gap-1">
              {t("workbench.fieldChart.cursor")}
              <input
                type="range"
                min={start + 1}
                max={entries.length}
                value={selected + 1}
                aria-valuetext={t("workbench.fieldChart.frame", {
                  value: selected + 1,
                })}
                onChange={(event) =>
                  select(event.currentTarget.valueAsNumber - 1)
                }
                disabled={selectionLocked}
                onPointerUp={(event) =>
                  select(event.currentTarget.valueAsNumber - 1)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") select(selected);
                }}
              />
            </label>
            {selectionLocked ? (
              <p className="text-muted-foreground">
                {t("workbench.fieldChart.selectionLocked")}
              </p>
            ) : null}
            <p role="status" className="wrap-anywhere">
              {t("workbench.fieldChart.frame", { value: selected + 1 })}
              {" · "}
              {activeValue === undefined
                ? t("workbench.fieldChart.gap")
                : `${activeReading!.value}${channel.unit ? " " + channel.unit : ""}`}
              {activeReading?.calibration &&
              activeReading.rawValue !== undefined ? (
                <>
                  {" · "}
                  {t("workbench.fields.calibrationOrigin", {
                    revision: activeReading.calibration.revision,
                    raw: activeReading.rawValue,
                  })}
                </>
              ) : null}
            </p>
            {spans.length ? (
              <ul
                aria-label={t("workbench.fields.source")}
                className="space-y-1"
              >
                {spans.map((span) => (
                  <li
                    key={span.event}
                    className="wrap-anywhere rounded border p-2 text-xs"
                  >
                    {t("workbench.fieldChart.event", { event: span.event })}
                    {" · "}
                    {t("workbench.fields.byteRange", span)}
                    {inspection.recordOrdinals?.has(span.event) ? (
                      <>
                        {" · "}
                        {t("workbench.fieldChart.record", {
                          record: inspection.recordOrdinals.get(span.event)!,
                        })}
                      </>
                    ) : null}{" "}
                    <code className="ml-2 select-all">{span.hex}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            {reveal ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => onRevealSource?.(reveal)}
              >
                {t("workbench.fieldChart.showReceiveBytes")}
              </Button>
            ) : null}
            <details>
              <summary className="cursor-pointer">
                {t("workbench.fieldChart.locateByByte")}
              </summary>
              <form
                className="mt-2 flex flex-wrap items-end gap-2"
                onSubmit={locateSource}
              >
                <label className="grid gap-1">
                  {t("workbench.fieldChart.sourceEvent")}
                  <Input
                    value={lookup.event}
                    maxLength={20}
                    inputMode="numeric"
                    onChange={(event) => {
                      setLookup({
                        ...lookup,
                        event: event.currentTarget.value,
                      });
                      setLookupMissed(false);
                    }}
                  />
                </label>
                <label className="grid gap-1">
                  {t("workbench.fieldChart.sourceByte")}
                  <Input
                    value={lookup.byte}
                    maxLength={20}
                    inputMode="numeric"
                    onChange={(event) => {
                      setLookup({ ...lookup, byte: event.currentTarget.value });
                      setLookupMissed(false);
                    }}
                  />
                </label>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={
                    selectionLocked ||
                    parseU64(lookup.event) === undefined ||
                    parseU64(lookup.byte) === undefined
                  }
                >
                  {t("workbench.fieldChart.locate")}
                </Button>
              </form>
              {lookupMissed ? (
                <p role="status">
                  {t("workbench.fieldChart.sourceUnavailable")}
                </p>
              ) : null}
            </details>
          </>
        ) : null}
      </section>
    </details>
  );
}
