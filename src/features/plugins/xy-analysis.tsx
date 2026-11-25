import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Target } from "@serial-workbench/contracts";
import { useHost } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { PluginError } from "./plugin-error";
import {
  alignXyAction,
  maxAnalysisInput,
  parseXyInput,
  runXyAnalysis,
  type XyReport,
} from "./xy-analysis-model";
import { XyAnalysisResult } from "./xy-analysis-result";

function lissajousExample() {
  const sample = (
    index: number,
    origin: number,
    step: number,
    value: number,
  ) => ({
    monoNs: String(origin + index * step),
    value: value.toFixed(8),
  });
  return JSON.stringify(
    {
      x: {
        sourceId: "sine",
        clockId: "clock-a",
        samples: Array.from({ length: 33 }, (_, i) =>
          sample(i, 50000, 1000, Math.sin((i * Math.PI) / 16)),
        ),
      },
      y: {
        sourceId: "cosine",
        clockId: "clock-b",
        samples: Array.from({ length: 17 }, (_, i) =>
          sample(i * 2, 20000, 1001, Math.cos((i * Math.PI) / 8)),
        ),
      },
      method: "linear",
      maxGapNs: "2000",
      anchors: [
        { xMonoNs: "50000", yMonoNs: "20000" },
        { xMonoNs: "82000", yMonoNs: "52032" },
      ],
    },
    null,
    2,
  );
}

function XyAnalysis({
  target,
  archiveSha256,
}: {
  target: Target;
  archiveSha256: string;
}) {
  const { t } = useI18n();
  const host = useHost();
  const id = useId();
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  const [report, setReport] = useState<XyReport>();
  const [example, setExample] = useState(false);
  useEffect(() => () => pending.current?.abort(), []);

  function discard() {
    const owner = pending.current;
    pending.current = null;
    owner?.abort();
    setBusy(false);
    setInput("");
    setInvalid(false);
    setProblem(null);
    setReport(undefined);
    setExample(false);
  }

  useUnsavedWork({
    id,
    label: t("plugins.xy.title"),
    dirty: Boolean(input.trim()) && !example,
    discard,
  });

  async function analyze(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const params = parseXyInput(input);
    if (!params) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    const owner = new AbortController();
    pending.current = owner;
    setBusy(true);
    setInvalid(false);
    setProblem(null);
    setReport(undefined);
    try {
      const result = await runXyAnalysis(
        host,
        target,
        archiveSha256,
        params,
        owner.signal,
      );
      if (!owner.signal.aborted) setReport(result);
    } catch (reason) {
      if (!owner.signal.aborted) setProblem(reason);
    } finally {
      if (pending.current === owner) {
        pending.current = null;
        if (!owner.signal.aborted) setBusy(false);
      }
    }
  }

  return (
    <section
      aria-labelledby={id + "-title"}
      className="grid gap-4 border-t pt-4"
    >
      <h3 id={id + "-title"} className="text-base font-semibold">
        {t("plugins.xy.title")}
      </h3>
      <form className="grid gap-2" onSubmit={analyze}>
        <Label htmlFor={id + "-input"}>{t("plugins.xy.input")}</Label>
        <p id={id + "-help"} className="max-w-prose text-muted-foreground">
          {t("plugins.xy.help")}
        </p>
        <Textarea
          ref={inputRef}
          id={id + "-input"}
          className="min-h-32 font-mono text-xs"
          spellCheck={false}
          maxLength={maxAnalysisInput}
          aria-invalid={invalid || undefined}
          aria-describedby={
            id + "-help" + (invalid ? " " + id + "-invalid" : "")
          }
          value={input}
          disabled={busy}
          onChange={(event) => {
            setInput(event.target.value);
            setExample(false);
            setProblem(null);
            setReport(undefined);
            setInvalid(false);
          }}
        />
        {invalid ? (
          <p role="alert" id={id + "-invalid"} className="text-destructive">
            {t("plugins.xy.invalid")}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={busy || !input.trim()}>
            {t("plugins.xy.run")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || (Boolean(input.trim()) && !example)}
            onClick={() => {
              setInput(lissajousExample());
              setExample(true);
              setInvalid(false);
              setProblem(null);
              setReport(undefined);
            }}
          >
            {t("plugins.xy.example")}
          </Button>
          {busy ? (
            <p role="status" className="text-muted-foreground">
              {t("plugins.xy.running")}
            </p>
          ) : null}
        </div>
      </form>
      <PluginError error={problem} message="plugins.xy.failed" />
      {report ? <XyAnalysisResult report={report} /> : null}
    </section>
  );
}

export default function XyAnalysisLauncher(props: {
  target: Target;
  archiveSha256: string;
}) {
  const { state } = useHost();
  const available = state.catalog.some(
    (action) =>
      action.actionId === alignXyAction && action.targetKinds.includes("host"),
  );
  return available ? <XyAnalysis {...props} /> : null;
}
