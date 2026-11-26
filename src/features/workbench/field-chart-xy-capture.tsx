import { useContext, useId, useMemo, useState } from "react";
import type { SessionSnapshot } from "@serial-workbench/contracts";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { parseU64 } from "@/lib/u64";
import { maxCapturedXySamples, type CapturedXyChannel } from "@/lib/xy-capture";
import { useI18n } from "@/providers/i18n";
import { useXyCapture } from "@/providers/xy-capture-context";
import type { FieldReading } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import {
  chartValue,
  fieldChartSpans,
  sharesChartSegment,
  type FieldChartFrame,
} from "./field-chart-model";
import type { FramingInspection } from "./framing-anomalies-model";
import { WorkbenchDialogExit } from "./workbench-dialog-exit";

export function capturedFieldChannel(
  inspection: FramingInspection,
  entries: readonly FieldChartFrame[],
  start: number,
  field: FieldReading,
):
  | { status: "ready"; channel: CapturedXyChannel }
  | { status: "range" | "time" } {
  if (entries.length - start > maxCapturedXySamples) return { status: "range" };
  const samples: CapturedXyChannel["samples"][number][] = [];
  let initial: FieldChartFrame["source"];
  let previousTime: bigint | undefined;
  let previous: FieldChartFrame | undefined;
  let omitted = 0;
  let gap = false;
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index]!;
    const source = entry.source;
    const monoNs = source?.endTime.sourceMonoNs;
    const time = parseU64(monoNs);
    if (!source || time === undefined || monoNs === undefined) {
      omitted += 1;
      gap = true;
      continue;
    }
    initial ??= source;
    if (
      source.key !== initial.key ||
      source.clock !== initial.clock ||
      (previousTime !== undefined && time < previousTime)
    )
      return { status: "time" };
    const reading = entry.readings?.find(({ id }) => id === field.id);
    const value = chartValue(entry, field.id);
    const spans = reading ? fieldChartSpans(entry, reading) : [];
    const first = spans[0];
    const last = spans.at(-1);
    const event = first?.event ?? entry.frame.eventStart;
    const record = inspection.recordOrdinals?.get(event);
    samples.push({
      monoNs,
      value: value === undefined ? null : (reading?.value ?? String(value)),
      ...(samples.length &&
      (gap || (previous && !sharesChartSegment(previous, entry)))
        ? { gapBefore: true }
        : {}),
      origin: {
        frame: index + 1,
        event,
        firstByte: first?.start ?? entry.frame.byteStart,
        afterByte: last?.end ?? entry.frame.byteEnd,
        ...(record !== undefined ? { record } : {}),
      },
    });
    previous = entry;
    previousTime = time;
    gap = false;
  }
  if (!initial || !samples.some(({ value }) => value !== null))
    return { status: "time" };
  return {
    status: "ready",
    channel: {
      field: field.id,
      host: inspection.target.hostId,
      instance: initial.instance,
      session: inspection.target.sessionId,
      clock: initial.clock,
      clockKey: JSON.stringify([
        inspection.target.hostId,
        initial.instance,
        initial.clock,
      ]),
      omitted,
      samples,
    },
  };
}

function OpenCrossSourceXy() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const exit = useContext(WorkbenchDialogExit);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        if (exit && !(await exit())) return;
        void navigate("/plugins?analysis=xy");
      }}
    >
      {t("workbench.fieldChart.xyOpen")}
    </Button>
  );
}

export function FieldChartXyCapture({
  inspection,
  entries,
  start,
  field,
  replaySession,
}: {
  inspection: FramingInspection;
  entries: readonly FieldChartFrame[];
  start: number;
  field: FieldReading;
  replaySession?: Pick<SessionSnapshot, "sessionId" | "sessionEpoch">;
}) {
  const state = useXyCapture();
  const { t } = useI18n();
  const id = useId();
  const owner = replaySession ?? inspection.target;
  const source =
    owner.sessionId && owner.sessionEpoch
      ? state?.source(
          { sessionId: owner.sessionId, sessionEpoch: owner.sessionEpoch },
          replaySession ? "replay" : "live",
        )
      : undefined;
  const [openedSource, setOpenedSource] = useState(source);
  if (!openedSource && source) setOpenedSource(source);
  const currentSource =
    source &&
    openedSource?.connection === source.connection &&
    openedSource.kind === source.kind &&
    openedSource.sessionId === source.sessionId &&
    openedSource.sessionEpoch === source.sessionEpoch &&
    openedSource.generation === source.generation
      ? source
      : undefined;
  const captured = useMemo(
    () =>
      state?.available
        ? capturedFieldChannel(inspection, entries, start, field)
        : undefined,
    [state?.available, inspection, entries, start, field],
  );
  if (!state?.available || !captured) return null;
  const { x, y } = state.axes;
  const note =
    captured.status === "ready"
      ? captured.channel.omitted
        ? t("workbench.fieldChart.xyOmitted", {
            count: captured.channel.omitted,
          })
        : undefined
      : t(
          captured.status === "range"
            ? "workbench.fieldChart.xyRange"
            : "workbench.fieldChart.xyTime",
        );
  return (
    <section
      aria-labelledby={id}
      className="grid gap-2 rounded-md border px-3 py-2"
    >
      <h4 id={id} className="font-medium">
        {t("plugins.xy.title")}
      </h4>
      <div className="flex flex-wrap gap-2">
        {(["x", "y"] as const).map((axis) => (
          <Button
            key={axis}
            type="button"
            size="sm"
            variant="outline"
            disabled={captured.status !== "ready" || !currentSource}
            onClick={() => {
              if (captured.status === "ready" && currentSource)
                state.stage(axis, captured.channel, currentSource);
            }}
          >
            {t(
              axis === "x"
                ? "workbench.fieldChart.xyStageX"
                : "workbench.fieldChart.xyStageY",
            )}
          </Button>
        ))}
        {x && y ? <OpenCrossSourceXy /> : null}
        {x || y ? (
          <Button type="button" size="sm" variant="ghost" onClick={state.clear}>
            {t("workbench.fieldChart.xyClear")}
          </Button>
        ) : null}
      </div>
      <div aria-live="polite">
        {x ? (
          <p className="wrap-anywhere">
            {t("workbench.fieldChart.xyStaged", {
              axis: "X",
              field: x.field,
              count: x.samples.length,
            })}
          </p>
        ) : null}
        {y ? (
          <p className="wrap-anywhere">
            {t("workbench.fieldChart.xyStaged", {
              axis: "Y",
              field: y.field,
              count: y.samples.length,
            })}
          </p>
        ) : null}
      </div>
      {note ? <p className="text-muted-foreground">{note}</p> : null}
    </section>
  );
}
