import { useId, useState, type FormEvent } from "react";
import { formatHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { OptionsSelect } from "@/components/options-select";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  compileProtocolFieldDocument,
  maxDefinitionLength,
  type FieldDefinitionFormat,
} from "../../../packages/plugin-sdk/examples/reference-framing/protocol-field-document";
import { ProtocolFieldError } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import {
  compareSessionFrames,
  type FrameAlignment,
  type SessionComparisonRow,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/session-comparison";
import type { ReplayComparisonSample } from "./session-comparison-model";
import type { useReplayComparison } from "./use-replay-comparison";
import { WorkbenchDialog } from "./workbench-dialog";

type Sources = {
  baseline: ReplayComparisonSample;
  candidate: ReplayComparisonSample;
};

function Overview({ sample }: { sample: ReplayComparisonSample }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0 wrap-anywhere">
      <p className="font-mono text-xs">
        {sample.source.sessionId} @ {sample.source.sessionEpoch}
      </p>
      <p>
        {t("workbench.comparison.source", {
          offset: sample.anchor,
          width: sample.width,
          count: sample.frames.length,
        })}
      </p>
      <p className="text-muted-foreground">
        {sample.gap ? t("workbench.comparison.gap") : ""}
        {sample.gap && sample.limited ? " · " : ""}
        {sample.limited ? t("workbench.comparison.limit") : ""}
      </p>
    </div>
  );
}

function FrameDetails({
  sample,
  position,
}: {
  sample: ReplayComparisonSample;
  position: bigint | undefined;
}) {
  const { t } = useI18n();
  const frame = sample.frames.find((value) => value.position === position);
  if (!frame) return <p>{t("workbench.comparison.unmatched")}</p>;
  const { source, bytes } = frame;
  return (
    <div className="min-w-0 space-y-2 wrap-anywhere">
      <p>
        {t("workbench.comparison.provenance", {
          eventStart: source.eventStart,
          eventEnd: source.eventEnd,
          byteStart: source.byteStart,
          byteEnd: source.byteEnd,
        })}
      </p>
      <p>
        {t("workbench.comparison.records", {
          first: source.firstRecord ?? "—",
          last: source.lastRecord ?? "—",
        })}
      </p>
      <pre
        className="max-h-32 overflow-auto whitespace-pre-wrap rounded border p-2 text-xs"
        data-surface="reading"
      >
        {formatHex(bytes)}
      </pre>
    </div>
  );
}

function ComparisonReport({
  rows,
  baseline,
  candidate,
}: Sources & {
  rows: SessionComparisonRow[];
}) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const selected = rows[index];
  return (
    <section
      className="grid min-w-0 gap-3"
      aria-label={t("workbench.comparison.results")}
    >
      <div
        role="region"
        aria-label={t("workbench.comparison.frameTable")}
        className="max-h-56 w-full min-w-0 overflow-auto rounded-md border focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        tabIndex={0}
      >
        <table className="w-full min-w-max text-start text-sm tabular-nums">
          <thead>
            <tr className="sticky top-0 bg-background text-muted-foreground">
              {(
                [
                  "baseline",
                  "candidate",
                  "bytes",
                  "fields",
                  "time",
                  "match",
                ] as const
              ).map((key) => (
                <th
                  key={key}
                  scope="col"
                  className="px-3 py-2 text-start font-medium"
                >
                  {t(`workbench.comparison.${key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={i}
                className={i === index ? "border-t bg-primary/10" : "border-t"}
              >
                <td className="px-3 py-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-pressed={i === index}
                    aria-label={t("workbench.comparison.inspect", {
                      left: String(row.left?.position ?? "—"),
                      right: String(row.right?.position ?? "—"),
                    })}
                    onClick={() => setIndex(i)}
                  >
                    {String(row.left?.position ?? "—")}
                  </Button>
                </td>
                <td className="px-3 py-1.5">
                  {String(row.right?.position ?? "—")}
                </td>
                <td className="px-3 py-1.5">{row.bytes?.count ?? "—"}</td>
                <td className="px-3 py-1.5">{row.fields?.length ?? "—"}</td>
                <td className="px-3 py-1.5">
                  {String(row.elapsedDeltaNs ?? "—")}
                </td>
                <td className="px-3 py-1.5">
                  {t(
                    !row.keyAvailable
                      ? "workbench.comparison.noKey"
                      : !row.left || !row.right
                        ? "workbench.comparison.unmatched"
                        : row.repeatedKey
                          ? "workbench.comparison.repeat"
                          : "workbench.comparison.paired",
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? (
        <>
          <div className="workbench-form-grid workbench-form-grid-pair">
            <div className="grid min-w-0 content-start gap-1.5 rounded-md border p-3">
              <h4 className="font-medium">
                {t("workbench.comparison.baseline")}
              </h4>
              <FrameDetails
                sample={baseline}
                position={selected.left?.position}
              />
            </div>
            <div className="grid min-w-0 content-start gap-1.5 rounded-md border p-3">
              <h4 className="font-medium">
                {t("workbench.comparison.candidate")}
              </h4>
              <FrameDetails
                sample={candidate}
                position={selected.right?.position}
              />
            </div>
          </div>
          <div className="text-sm">
            <h4 className="font-medium">
              {t("workbench.comparison.byteRanges")}
            </h4>
            <p className="max-h-20 overflow-auto wrap-anywhere font-mono">
              {selected.bytes?.ranges
                .map(({ start, end }) => "[" + start + ", " + end + ")")
                .join(" · ") || "—"}
            </p>
          </div>
          {selected.fields?.length ? (
            <div className="max-h-40 overflow-auto text-sm">
              <h4 className="font-medium">
                {t("workbench.comparison.fieldDetails")}
              </h4>
              <ul>
                {selected.fields.map(({ id, left, right }) => (
                  <li className="wrap-anywhere" key={id}>
                    {id} · {left.value} [{left.rawHex}] → {right.value} [
                    {right.rawHex}]
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function ComparisonForm({ baseline, candidate }: Sources) {
  const { t } = useI18n();
  const id = useId();
  const [mode, setMode] = useState<FrameAlignment["kind"]>("ordinal");
  const [prefix, setPrefix] = useState("1");
  const [fields, setFields] = useState("");
  const [format, setFormat] = useState<FieldDefinitionFormat>("json");
  const [definition, setDefinition] = useState("");
  const [error, setError] = useState("");
  const [report, setReport] = useState<{
    serial: number;
    rows: SessionComparisonRow[];
  }>();
  useUnsavedWork({
    id,
    label: t("workbench.comparison.definition"),
    dirty: Boolean(definition.trim()),
    retainAfterUnmount: false,
    discard: () => {
      setDefinition("");
      setReport(undefined);
      setError("");
    },
  });
  function clearReport() {
    setReport(undefined);
    setError("");
  }

  function compare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const codec = definition.trim()
        ? compileProtocolFieldDocument(definition, format).codec
        : undefined;
      const alignment: FrameAlignment =
        mode === "prefix"
          ? { kind: mode, length: Number(prefix) }
          : mode === "fields"
            ? {
                kind: mode,
                ids: fields
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
              }
            : { kind: mode };
      const rows = compareSessionFrames(
        baseline.frames,
        candidate.frames,
        alignment,
        codec,
      );
      setReport((previous) => ({ serial: (previous?.serial ?? 0) + 1, rows }));
    } catch (reason) {
      setReport(undefined);
      setError(
        reason instanceof ProtocolFieldError
          ? reason.path
          : t("workbench.comparison.invalid"),
      );
    }
  }
  return (
    <div className="grid min-w-0 gap-3">
      <form className="grid min-w-0 gap-3" onSubmit={compare}>
        <div className="workbench-form-grid workbench-form-grid-pair">
          <div className="grid gap-1">
            <label htmlFor={id + "-mode"}>
              {t("workbench.comparison.alignment")}
            </label>
            <OptionsSelect
              id={id + "-mode"}
              value={mode}
              options={(
                [
                  ["ordinal", t("workbench.comparison.ordinal")],
                  ["prefix", t("workbench.comparison.prefix")],
                  ["fields", t("workbench.comparison.fieldsKey")],
                ] as const
              ).map(([value, label]) => ({ value, label }))}
              onValueChange={(value) => {
                if (
                  value === "ordinal" ||
                  value === "prefix" ||
                  value === "fields"
                ) {
                  setMode(value);
                  clearReport();
                }
              }}
            />
          </div>
          {mode === "prefix" ? (
            <label className="grid gap-1">
              {t("workbench.comparison.prefixLength")}
              <Input
                value={prefix}
                onChange={(event) => {
                  setPrefix(event.currentTarget.value);
                  clearReport();
                }}
                inputMode="numeric"
                required
                pattern="[0-9]{1,2}"
              />
            </label>
          ) : null}
          {mode === "fields" ? (
            <label className="grid gap-1">
              {t("workbench.comparison.fieldIds")}
              <Input
                value={fields}
                onChange={(event) => {
                  setFields(event.currentTarget.value);
                  clearReport();
                }}
                maxLength={256}
                required
              />
            </label>
          ) : null}
        </div>
        <details open={mode === "fields" ? true : undefined}>
          <summary className="cursor-pointer">
            {t("workbench.comparison.definition")}
          </summary>
          <div className="mt-2 grid gap-2">
            <label htmlFor={id + "-format"}>
              {t("workbench.comparison.format")}
            </label>
            <OptionsSelect
              id={id + "-format"}
              value={format}
              options={[
                { value: "json", label: "JSON" },
                { value: "yaml", label: "YAML" },
              ]}
              onValueChange={(value) => {
                if (value === "json" || value === "yaml") {
                  setFormat(value);
                  clearReport();
                }
              }}
            />
            <Textarea
              aria-label={t("workbench.comparison.definition")}
              value={definition}
              maxLength={maxDefinitionLength}
              className="min-h-24 font-mono text-xs"
              onChange={(event) => {
                setDefinition(event.currentTarget.value);
                clearReport();
              }}
            />
          </div>
        </details>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="workbench-tool-footer">
          <Button type="submit">{t("workbench.comparison.run")}</Button>
        </div>
      </form>
      {report ? (
        <ComparisonReport
          key={report.serial}
          rows={report.rows}
          baseline={baseline}
          candidate={candidate}
        />
      ) : null}
    </div>
  );
}

export default function ReplayComparisonDialog({
  scope,
  closeLabel,
  comparison,
}: {
  scope: string;
  closeLabel: string;
  comparison: ReturnType<typeof useReplayComparison>;
}) {
  const { t } = useI18n();
  const { baseline, candidate } = comparison;
  return (
    <WorkbenchDialog
      open={comparison.open}
      title={t("workbench.comparison.title")}
      scopeKey={scope}
      closeLabel={closeLabel}
      returnFocus={comparison.trigger}
      onRequestClose={comparison.close}
    >
      {(beforeReplace) => (
        <div className="grid min-w-0 gap-4">
          <div className="workbench-form-grid workbench-form-grid-pair">
            <div className="grid min-w-0 content-start gap-1.5 rounded-md border p-3">
              <h3 className="font-medium">
                {t("workbench.comparison.baseline")}
              </h3>
              {baseline ? (
                <Overview sample={baseline} />
              ) : (
                <p>{t("workbench.comparison.noSample")}</p>
              )}
            </div>
            <div className="grid min-w-0 content-start gap-1.5 rounded-md border p-3">
              <h3 className="font-medium">
                {t("workbench.comparison.candidate")}
              </h3>
              {candidate ? (
                <Overview sample={candidate} />
              ) : (
                <p>{t("workbench.comparison.noSample")}</p>
              )}
            </div>
          </div>
          {comparison.checking ? (
            <p role="status">{t("workbench.comparison.checking")}</p>
          ) : null}
          {baseline && candidate ? (
            <ComparisonForm baseline={baseline} candidate={candidate} />
          ) : (
            <p>{t("workbench.comparison.selectBoth")}</p>
          )}
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void beforeReplace().then((allowed) => {
                  if (allowed) comparison.clear();
                });
              }}
            >
              {t("workbench.comparison.clear")}
            </Button>
          </div>
        </div>
      )}
    </WorkbenchDialog>
  );
}
