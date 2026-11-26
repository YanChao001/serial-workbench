import { useId, useRef, useState, type FormEvent } from "react";
import type { SessionSnapshot } from "@serial-workbench/contracts";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { saveTextExport } from "@/lib/tauri";
import { parseU64 } from "@/lib/u64";
import { useI18n } from "@/providers/i18n";
import { sampleStatistics } from "../../../packages/plugin-sdk/examples/reference-chart/sample-statistics";
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
import { fieldChartCsv, type FieldChartMode } from "./field-chart-csv";
import { FieldChartMdf4 } from "./field-chart-mdf4-button";
import { FieldChartXyCapture } from "./field-chart-xy-capture";
import { FieldXyPlot } from "./field-xy-plot";

type Point = { index: number; value: number };
const statisticMetrics = [
  "minimum",
  "maximum",
  "average",
  "deviation",
  "p50",
  "p95",
  "p99",
] as const;
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
  replaySession,
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
  replaySession?: Pick<SessionSnapshot, "sessionId" | "sessionEpoch">;
  sourceSelection?: ChartSourceSelection;
  onRevealSource?: (source: ChartSourceSelection) => void;
  onSelect: (entry: FieldChartFrame, field: string) => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [plot, setPlot] = useState<Plot>();
  const [compact, setCompact] = useState(false);
  const [mode, setMode] = useState<FieldChartMode>("trace");
  const [yField, setYField] = useState("");
  const [recent, setRecent] = useState(false);
  const [lookup, setLookup] = useState({ event: "", byte: "" });
  const [lookupMissed, setLookupMissed] = useState(false);
  const savingCsv = useRef(false);
  const [csvPending, setCsvPending] = useState(false);
  const [csvResult, setCsvResult] = useState<{
    plot: Plot;
    start: number;
    mode: FieldChartMode;
    primary: string;
    paired?: string;
    status: "saved" | "error";
  }>();
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
  const yOptions = fields.filter((reading) => reading.id !== channel?.id);
  const yChannel =
    yOptions.find((reading) => reading.id === yField) ?? yOptions[0];
  const paired = mode !== "trace" ? yChannel : undefined;
  const selected = Math.max(
    0,
    entries.findIndex((entry) => entry.frame === frame),
  );
  const recentStart = Math.max(0, entries.length - 32);
  const showRecent = recent && selected >= recentStart;
  const start = showRecent ? recentStart : 0;
  const active = entries[selected];
  const chartMode = paired ? mode : "trace";
  const visibleCsvResult =
    csvResult?.plot === current &&
    csvResult?.start === start &&
    csvResult.mode === chartMode &&
    csvResult.primary === channel?.id &&
    csvResult.paired === paired?.id
      ? csvResult.status
      : undefined;

  async function handleSaveCsv() {
    if (!current || !channel || savingCsv.current) return;
    savingCsv.current = true;
    setCsvPending(true);
    setCsvResult(undefined);
    const scope = {
      plot: current,
      start,
      mode: chartMode,
      primary: channel.id,
      paired: paired?.id,
    };
    try {
      const content = fieldChartCsv({
        inspection,
        entries,
        start,
        mode: chartMode,
        primary: channel,
        paired,
      });
      const saved = await saveTextExport(
        "serial-workbench-field-chart.csv",
        content,
      );
      if (saved !== null) setCsvResult({ ...scope, status: "saved" });
    } catch {
      setCsvResult({ ...scope, status: "error" });
    } finally {
      savingCsv.current = false;
      setCsvPending(false);
    }
  }

  const segments: Point[][] = [];
  const validValues: number[] = [];
  let segment: Point[] | undefined;
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
      validValues.push(value);
    }
  }
  const first = entries[start];
  const last = entries.at(-1);
  const width = inspection.fixedFrameWidth;
  const expectedCount =
    width !== undefined && first && last
      ? (BigInt(last.frame.byteStart) - BigInt(first.frame.byteStart)) /
          BigInt(width) +
        1n
      : BigInt(entries.length - start);
  const statistics = sampleStatistics(validValues, expectedCount);
  const minimum = statistics.metrics?.minimum ?? 0;
  const maximum = statistics.metrics?.maximum ?? 0;
  const number = new Intl.NumberFormat(language, {
    maximumSignificantDigits: 8,
  });
  const percent = new Intl.NumberFormat(language, {
    style: "percent",
    maximumFractionDigits: 2,
  });
  const activeReading = active?.readings?.find(
    (reading) => reading.id === channel?.id,
  );
  const activeValue =
    active && channel ? chartValue(active, channel.id) : undefined;
  const displayedValue =
    activeValue === undefined
      ? t("workbench.fieldChart.gap")
      : `${activeReading!.value}${channel?.unit ? " " + channel.unit : ""}`;
  const spans =
    active && activeReading ? fieldChartSpans(active, activeReading) : [];
  const reveal =
    active && activeReading && onRevealSource
      ? fieldChartSelection(active, activeReading)
      : undefined;
  const yReading = active?.readings?.find(
    (reading) => reading.id === paired?.id,
  );
  const yValue = active && paired ? chartValue(active, paired.id) : undefined;
  const yReveal =
    active && yReading && onRevealSource
      ? fieldChartSelection(active, yReading)
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
              {yChannel ? (
                <div className="grid gap-1">
                  <label htmlFor={id + "-mode"}>
                    {t("workbench.fieldChart.mode")}
                  </label>
                  <OptionsSelect
                    id={id + "-mode"}
                    value={mode}
                    onValueChange={(value) => {
                      if (
                        value === "trace" ||
                        value === "xy" ||
                        value === "scatter"
                      )
                        setMode(value);
                    }}
                    options={[
                      {
                        value: "trace",
                        label: t("workbench.fieldChart.trace"),
                      },
                      { value: "xy", label: t("workbench.fieldChart.xy") },
                      {
                        value: "scatter",
                        label: t("workbench.fieldChart.scatter"),
                      },
                    ]}
                  />
                </div>
              ) : null}
              <div className="grid gap-1">
                <label htmlFor={id + "-channel"}>
                  {t(
                    paired
                      ? "workbench.fieldChart.xField"
                      : "workbench.fields.name",
                  )}
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
              {paired ? (
                <div className="grid gap-1">
                  <label htmlFor={id + "-y-channel"}>
                    {t("workbench.fieldChart.yField")}
                  </label>
                  <OptionsSelect
                    id={id + "-y-channel"}
                    value={paired.id}
                    onValueChange={setYField}
                    options={yOptions.map((reading) => ({
                      value: reading.id,
                      label: reading.unit
                        ? `${reading.id} (${reading.unit})`
                        : reading.id,
                    }))}
                  />
                </div>
              ) : null}
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
              {!paired ? (
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={compact}
                    onCheckedChange={(value) => setCompact(value === true)}
                  />
                  {t("workbench.fieldChart.compact")}
                </label>
              ) : null}
              <Button
                type="button"
                variant="outline"
                onClick={handleSaveCsv}
                disabled={csvPending}
              >
                {t("workbench.fieldChart.exportCsv")}
              </Button>
              <FieldChartMdf4
                inspection={inspection}
                entries={entries}
                start={start}
                primary={channel}
                paired={paired}
                replaySession={replaySession}
              />
            </div>
            <FieldChartXyCapture
              inspection={inspection}
              entries={entries}
              start={start}
              field={channel}
              replaySession={replaySession}
            />
            <div aria-live="polite">
              {visibleCsvResult === "saved" ? (
                <p className="text-muted-foreground">
                  {t("workbench.fieldChart.csvSaved")}
                </p>
              ) : null}
            </div>
            {visibleCsvResult === "error" ? (
              <p role="alert" className="text-destructive">
                {t("workbench.fieldChart.csvFailed")}
              </p>
            ) : null}
            {paired ? (
              <FieldXyPlot
                entries={entries}
                start={start}
                selected={selected}
                xField={channel.id}
                yField={paired.id}
                connect={mode === "xy"}
                onSelect={select}
              />
            ) : (
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
            )}
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
              {paired
                ? t("workbench.fieldChart.xValue", { value: displayedValue })
                : displayedValue}
              {paired ? (
                <>
                  {" · "}
                  {t("workbench.fieldChart.yValue", {
                    value:
                      yValue === undefined
                        ? t("workbench.fieldChart.gap")
                        : `${yReading!.value}${paired.unit ? " " + paired.unit : ""}`,
                  })}
                </>
              ) : null}
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
            {!paired ? (
              <details>
                <summary className="cursor-pointer">
                  {t("workbench.fieldChart.statistics.title")}
                </summary>
                <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-2 tabular-nums">
                  {statisticMetrics.map((metric) => {
                    const value = statistics.metrics?.[metric];
                    return (
                      <div key={metric}>
                        <dt>
                          {t(`workbench.fieldChart.statistics.${metric}`)}
                        </dt>
                        <dd className="font-medium">
                          {value === undefined ? "—" : number.format(value)}
                        </dd>
                      </div>
                    );
                  })}
                  <div>
                    <dt>{t("workbench.fieldChart.statistics.valid")}</dt>
                    <dd className="font-medium">
                      {number.format(statistics.validCount)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("workbench.fieldChart.statistics.missing")}</dt>
                    <dd className="font-medium">
                      {statistics.missingCount.toLocaleString(language)}
                      {" / "}
                      {statistics.expectedCount.toLocaleString(language)}
                      {statistics.missingRate === undefined
                        ? ""
                        : ` (${percent.format(statistics.missingRate)})`}
                    </dd>
                  </div>
                </dl>
                <p className="mt-1 text-muted-foreground">
                  {t(
                    width === undefined
                      ? "workbench.fieldChart.statistics.observedScope"
                      : "workbench.fieldChart.statistics.replayScope",
                  )}
                </p>
              </details>
            ) : null}
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
            {yReveal ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => onRevealSource?.(yReveal)}
              >
                {t("workbench.fieldChart.showYBytes")}
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
