import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { isRecord } from "@/lib/settings-model";
import { useI18n } from "@/providers/i18n";
import type { Translate } from "@/i18n/translate";
import {
  compileProtocolFieldDocument,
  type FieldDefinitionFormat,
} from "../../../packages/plugin-sdk/examples/reference-framing/protocol-field-document";
import { ProtocolFieldError } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import {
  inspectFraming,
  type FramingFinding,
  type FramingInspection,
} from "./framing-anomalies-model";
import { timingMilliseconds } from "./modbus-timeline-model";

function describe(finding: FramingFinding, t: Translate) {
  switch (finding.kind) {
    case "length":
      return t("workbench.anomalies.length", {
        length: finding.length,
        expected: finding.expected,
      });
    case "checksum":
      return t("workbench.anomalies.checksum", {
        field: finding.field,
        actual: finding.actual,
        expected: finding.expected,
      });
    case "decode":
      return t("workbench.anomalies.decode", { path: finding.path });
    case "duplicate":
      return finding.sequence === undefined
        ? t("workbench.anomalies.duplicateBytes")
        : t("workbench.anomalies.duplicateSequence", {
            sequence: finding.sequence,
          });
    case "missing":
      return t("workbench.anomalies.missing", {
        expected: finding.expected,
        actual: finding.actual,
        count: finding.count,
      });
    case "sequence_jump":
      return t("workbench.anomalies.sequenceJump", {
        expected: finding.expected,
        actual: finding.actual,
      });
    case "timeout":
      return t(
        finding.tail
          ? "workbench.anomalies.tailTimeout"
          : "workbench.anomalies.timeout",
        {
          elapsed: timingMilliseconds(finding.elapsedNs),
          clock: finding.clock,
          event: String(finding.lastEvent),
        },
      );
  }
}

type Result = {
  source: FramingInspection;
  definition: string;
  format: FieldDefinitionFormat;
  report?: ReturnType<typeof inspectFraming>;
  error?: string;
};

function boundedInteger(input: string, min: number, max: number) {
  if (!/^\d{1,5}$/.test(input)) return undefined;
  const value = Number(input);
  return value >= min && value <= max ? value : undefined;
}

export function FramingAnomaliesTool({
  inspection,
  definition,
  format,
}: {
  inspection: FramingInspection;
  definition: string;
  format: FieldDefinitionFormat;
}) {
  const { t } = useI18n();
  const [sequenceField, setSequenceField] = useState("");
  const [missingLimit, setMissingLimit] = useState("16");
  const [timeout, setTimeoutMs] = useState("");
  const [repeatBytes, setRepeatBytes] = useState(false);
  const [result, setResult] = useState<Result>();
  const current =
    result?.source === inspection &&
    result.definition === definition &&
    result.format === format
      ? result
      : undefined;
  const timeoutMs = boundedInteger(timeout, 1, 60_000);
  const missing = boundedInteger(missingLimit, 0, 65_535);
  const field = sequenceField.trim();
  const valid =
    (!timeout || timeoutMs !== undefined) && (!field || missing !== undefined);
  const enabled = Boolean(definition.trim() || timeout || repeatBytes);

  function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || !enabled) return;
    const snapshot = { source: inspection, definition, format };
    try {
      const compiled = definition.trim()
        ? compileProtocolFieldDocument(definition, format)
        : undefined;
      if (field) {
        const document = compiled?.definition;
        const fields: readonly unknown[] =
          isRecord(document) && Array.isArray(document.fields)
            ? document.fields
            : [];
        if (
          !fields.some(
            (entry) =>
              isRecord(entry) &&
              entry.id === field &&
              (entry.kind === "integer" || entry.kind === "bits"),
          )
        ) {
          setResult({ ...snapshot, error: "sequenceField" });
          return;
        }
      }
      const report = inspectFraming(inspection, compiled?.codec, {
        sequenceField: field || undefined,
        missingLimit: BigInt(missing ?? 0),
        timeoutNs:
          timeoutMs === undefined ? undefined : BigInt(timeoutMs) * 1_000_000n,
        repeatBytes,
      });
      setResult({ ...snapshot, report });
    } catch (reason) {
      if (!(reason instanceof ProtocolFieldError)) throw reason;
      setResult({ ...snapshot, error: reason.path });
    }
  }

  return (
    <details className="rounded-md border px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">
        {t("workbench.anomalies.title")}
      </summary>
      <form className="mt-3 space-y-2" onSubmit={run}>
        <p className="text-muted-foreground">
          {t("workbench.anomalies.evidence")}
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <label className="grid gap-1">
            {t("workbench.anomalies.sequence")}
            <Input
              value={sequenceField}
              maxLength={64}
              spellCheck={false}
              onChange={(event) => {
                setSequenceField(event.currentTarget.value);
                setResult(undefined);
              }}
            />
          </label>
          <label className="grid gap-1">
            {t("workbench.anomalies.missingLimit")}
            <Input
              type="number"
              min={0}
              max={65535}
              value={missingLimit}
              disabled={!field}
              onChange={(event) => {
                setMissingLimit(event.currentTarget.value);
                setResult(undefined);
              }}
            />
          </label>
          <label className="grid gap-1">
            {t("workbench.anomalies.timeoutLimit")}
            <Input
              type="number"
              min={1}
              max={60000}
              value={timeout}
              onChange={(event) => {
                setTimeoutMs(event.currentTarget.value);
                setResult(undefined);
              }}
            />
          </label>
        </div>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={repeatBytes}
            onCheckedChange={(checked) => {
              setRepeatBytes(checked === true);
              setResult(undefined);
            }}
          />
          {t("workbench.anomalies.repeat")}
        </label>
        <Button type="submit" variant="outline" disabled={!valid || !enabled}>
          {t("workbench.anomalies.inspect")}
        </Button>
      </form>
      {current?.error ? (
        <p className="mt-2 text-destructive" role="alert">
          {current.error === "sequenceField"
            ? t("workbench.anomalies.invalidSequence")
            : t("workbench.fields.invalidDefinition", { path: current.error })}
        </p>
      ) : null}
      {current?.report ? (
        <div className="mt-2 space-y-2">
          <p role="status">
            {t("workbench.anomalies.summary", {
              frames: current.report.frames,
              findings: current.report.findings.length,
            })}
          </p>
          {current.report.unavailableTransitions ? (
            <p>
              {t("workbench.anomalies.gaps", {
                count: current.report.unavailableTransitions,
              })}
            </p>
          ) : null}
          {current.report.findings.length ? (
            <ol className="max-h-64 list-disc space-y-2 overflow-auto pl-4 text-xs">
              {current.report.findings.slice(0, 128).map((finding, index) => (
                <li key={index}>
                  <span>{describe(finding, t)}</span>
                  <code className="block">
                    {t("workbench.framing.range", { ...finding.frame })}
                  </code>
                </li>
              ))}
            </ol>
          ) : null}
          {current.report.findings.length > 128 ? (
            <p>{t("workbench.anomalies.limited")}</p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
