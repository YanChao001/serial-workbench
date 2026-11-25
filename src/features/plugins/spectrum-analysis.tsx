import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Target } from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useHost } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { readAnalysisReport, parseAnalysisInput } from "./analysis-report";
import { PluginError } from "./plugin-error";
import {
  parseSpectrumReport,
  spectrumAction,
  type SpectrumReport,
} from "./spectrum-report";
import { SpectrumResult } from "./spectrum-result";

const maxInputLength = 524288;
const example = {
  clockId: "example-clock",
  unit: "V",
  firstPosition: "1",
  periodNs: "1000000",
  expectedSlots: 24,
  samples: [0, 2, 0, -2, 0, 2, 0, -2, 4, -4, 4, -4, 4, -4, 4, -4].map(
    (value, index) => ({
      position: String(index + 1),
      value: String(value),
    }),
  ),
  window: {
    size: 8,
    hop: 8,
    shape: "rectangular",
    detrend: "none",
    missing: "skip",
  },
  histogram: { bins: 8 },
};

type Props = { target: Target; archiveSha256: string };

function SpectrumAnalysis({ target, archiveSha256 }: Props) {
  const { t } = useI18n();
  const host = useHost();
  const id = useId();
  const editor = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [input, setInput] = useState("");
  const [usingExample, setUsingExample] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<SpectrumReport>();
  useEffect(() => () => pending.current?.abort(), []);
  function replace(value: string, demo: boolean) {
    setInput(value);
    setUsingExample(demo);
    setError(undefined);
    setInvalid(false);
    setResult(undefined);
  }
  useUnsavedWork({
    id,
    label: t("plugins.spectrum.title"),
    dirty: Boolean(input.trim()) && !usingExample,
    discard: () => {
      pending.current?.abort();
      pending.current = null;
      setBusy(false);
      replace("", false);
    },
  });
  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const params = parseAnalysisInput(input, maxInputLength);
    if (!params) {
      setInvalid(true);
      editor.current?.focus();
      return;
    }
    const owner = new AbortController();
    pending.current = owner;
    setBusy(true);
    setInvalid(false);
    setError(undefined);
    setResult(undefined);
    try {
      const contents = await readAnalysisReport(
        host,
        target,
        archiveSha256,
        spectrumAction,
        params,
        owner.signal,
      );
      if (!owner.signal.aborted) setResult(parseSpectrumReport(contents));
    } catch (problem) {
      if (!owner.signal.aborted) setError(problem);
    } finally {
      if (pending.current === owner) {
        pending.current = null;
        if (!owner.signal.aborted) setBusy(false);
      }
    }
  }
  return (
    <details className="border-t pt-4">
      <summary className="cursor-pointer text-base font-semibold">
        {t("plugins.spectrum.title")}
      </summary>
      <section
        aria-label={t("plugins.spectrum.title")}
        className="mt-3 grid min-w-0 gap-3"
      >
        <form className="grid gap-2" onSubmit={analyze}>
          <Label htmlFor={id + "-input"}>{t("plugins.spectrum.input")}</Label>
          <p id={id + "-help"} className="max-w-prose text-muted-foreground">
            {t("plugins.spectrum.help")}
          </p>
          <Textarea
            id={id + "-input"}
            ref={editor}
            maxLength={maxInputLength}
            value={input}
            className="min-h-32 min-w-0 font-mono text-xs"
            disabled={busy}
            spellCheck={false}
            aria-describedby={
              id + "-help" + (invalid ? " " + id + "-invalid" : "")
            }
            aria-invalid={invalid || undefined}
            onChange={(event) => replace(event.currentTarget.value, false)}
          />
          {invalid ? (
            <p role="alert" id={id + "-invalid"} className="text-destructive">
              {t("plugins.xy.invalid")}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || !input.trim()}>
              {t("plugins.spectrum.run")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || (Boolean(input.trim()) && !usingExample)}
              onClick={() => replace(JSON.stringify(example, null, 2), true)}
            >
              {t("plugins.spectrum.example")}
            </Button>
          </div>
          {busy ? (
            <p role="status" className="text-muted-foreground">
              {t("plugins.spectrum.running")}
            </p>
          ) : null}
        </form>
        <PluginError error={error} message="plugins.spectrum.failed" />
        {result ? <SpectrumResult report={result} /> : null}
      </section>
    </details>
  );
}

export default function SpectrumAnalysisLauncher(props: Props) {
  const { state } = useHost();
  return state.catalog.some(
    (action) =>
      action.actionId === spectrumAction && action.targetKinds.includes("host"),
  ) ? (
    <SpectrumAnalysis {...props} />
  ) : null;
}
