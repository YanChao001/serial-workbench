import { useId, useMemo, useState, type FormEvent } from "react";
import type { CaptureRecord } from "@serial-workbench/contracts";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseU64 } from "@/lib/u64";
import { useI18n } from "@/providers/i18n";
import { streamSourceKey } from "@/lib/stream-source";
import ProtocolFieldPreview from "./protocol-field-preview";
import { replayFieldPage, replayFieldSources } from "./replay-field-source";
import {
  streamHexEventSource,
  type ChartSourceSelection,
} from "./stream-chart-selection";

export default function ReplayFieldChart({
  records,
  sourceSelection,
  onRevealSource,
}: {
  records: readonly CaptureRecord[];
  sourceSelection?: ChartSourceSelection;
  onRevealSource?: (source: ChartSourceSelection) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const sources = useMemo(() => replayFieldSources(records), [records]);
  const chosen = useMemo(
    () =>
      sourceSelection &&
      records.find(
        ({ entry }) =>
          entry.kind === "event" &&
          streamHexEventSource(entry.value) ===
            sourceSelection.range.start.source,
      )?.entry,
    [records, sourceSelection],
  );
  const [sourceKey, setSourceKey] = useState("");
  const [offset, setOffset] = useState("");
  const [width, setWidth] = useState("");
  const [attempt, setAttempt] = useState<{
    records: readonly CaptureRecord[];
    sourceKey: string;
    offset: string;
    width: string;
    result: ReturnType<typeof replayFieldPage>;
  }>();
  const key = sources.has(sourceKey)
    ? sourceKey
    : chosen?.kind === "event"
      ? streamSourceKey(chosen.value)
      : (sources.keys().next().value ?? "");
  const source = sources.get(key);
  const at = parseU64(offset);
  const length = /^\d{1,4}$/.test(width) ? Number(width) : 0;
  const valid = source && at !== undefined && length >= 1 && length <= 4096;
  const current =
    attempt?.records === records &&
    attempt.sourceKey === key &&
    attempt.offset === offset &&
    attempt.width === width
      ? attempt
      : undefined;
  const outcome = current?.result;

  function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    setAttempt({
      records,
      sourceKey: key,
      offset,
      width,
      result: replayFieldPage(records, source, at, length),
    });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={analyze} className="space-y-3">
        <div className="grid gap-1">
          <label htmlFor={id + "-source"}>
            {t("workbench.framing.source")}
          </label>
          <OptionsSelect
            id={id + "-source"}
            value={key}
            onValueChange={setSourceKey}
            options={Array.from(sources, ([value, entry]) => ({
              value,
              label: `${entry.hostId} @ ${entry.instanceEpoch} / ${entry.sessionId} @ ${entry.sessionEpoch}`,
            }))}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            {t("workbench.fieldChart.replayOffset")}
            <Input
              value={offset}
              inputMode="numeric"
              maxLength={20}
              onChange={(event) => setOffset(event.currentTarget.value)}
            />
          </label>
          <label className="grid gap-1">
            {t("workbench.framing.fixedLength")}
            <Input
              value={width}
              inputMode="numeric"
              maxLength={4}
              onChange={(event) => setWidth(event.currentTarget.value)}
            />
          </label>
        </div>
        <Button type="submit" variant="outline" disabled={!valid}>
          {t("workbench.framing.scan")}
        </Button>
      </form>
      {current && !outcome ? (
        <p role="alert" className="text-destructive">
          {t("workbench.fieldChart.replayAbsent")}
        </p>
      ) : null}
      {outcome ? (
        <>
          <p role="status">
            {t("workbench.fieldChart.replayFrames", {
              count: outcome.inspection.frames.length,
            })}
            {outcome.gap ? ` · ${t("workbench.fieldChart.replayGap")}` : ""}
            {outcome.limited
              ? ` · ${t("workbench.fieldChart.replayLimit")}`
              : ""}
          </p>
        </>
      ) : null}
      {attempt ? (
        <ProtocolFieldPreview
          frames={outcome?.inspection.frames ?? []}
          inspection={outcome?.inspection}
          sourceSelection={sourceSelection}
          onRevealSource={onRevealSource}
          readOnly
        />
      ) : null}
    </div>
  );
}
