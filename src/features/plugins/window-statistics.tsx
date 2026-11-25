import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Target } from "@serial-workbench/contracts";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { parseU64 } from "@/lib/u64";
import { useHost } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { parseAnalysisInput, readAnalysisReport } from "./analysis-report";
import { PluginError } from "./plugin-error";
import {
  parseWindowsReport,
  windowsAction,
  type WindowsReport,
} from "./windows-report";
import { WindowsResult } from "./windows-result";

const maxInputLength = 524288;
const example = {
  firstPosition: "5",
  expectedSlots: 4,
  unit: "V",
  samples: [
    { position: "5", value: "1.25" },
    { position: "7", value: 2 },
  ],
};
const exampleText = JSON.stringify(example, null, 2);
type Options = {
  kind: "count" | "time";
  length: string;
  step: string;
  clockId: string;
  originMonoNs: string;
  periodNs: string;
};

const defaults: Options = {
  kind: "count",
  length: "2",
  step: "1",
  clockId: "",
  originMonoNs: "",
  periodNs: "",
};

type OptionField = Exclude<keyof Options, "kind">;
type Props = { target: Target; archiveSha256: string };

function WindowStatistics({ target, archiveSha256 }: Props) {
  const { t } = useI18n();
  const host = useHost();
  const id = useId();
  const editor = useRef<HTMLTextAreaElement>(null);
  const optionsForm = useRef<HTMLFieldSetElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [text, setText] = useState("");
  const [options, setOptions] = useState(defaults);
  const [editedOptions, setEditedOptions] = useState(false);
  const hasCustomSamples = Boolean(text.trim()) && text !== exampleText;
  const [busy, setBusy] = useState(false);
  const [inputIssue, setInputIssue] = useState<"input" | OptionField>();
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<WindowsReport>();

  useEffect(() => () => pending.current?.abort(), []);

  function clearReport() {
    setError(undefined);
    setResult(undefined);
    setInputIssue(undefined);
  }

  function replaceOptions(change: Partial<Options>) {
    clearReport();
    setEditedOptions(true);
    setOptions((current) => ({ ...current, ...change }));
  }

  useUnsavedWork({
    id,
    label: t("plugins.windows.title"),
    dirty: hasCustomSamples || editedOptions,
    discard: () => {
      pending.current?.abort();
      pending.current = null;
      setBusy(false);
      setText("");
      setOptions(defaults);
      setEditedOptions(false);
      clearReport();
    },
  });

  async function calculate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    clearReport();
    const grid = parseAnalysisInput(text, maxInputLength);
    if (!grid) {
      setInputIssue("input");
      editor.current?.focus();
      return;
    }
    const { kind, length, step, clockId, originMonoNs, periodNs } = options;
    const fields: OptionField[] =
      kind === "time"
        ? ["length", "step", "clockId", "originMonoNs", "periodNs"]
        : ["length", "step"];
    const invalid = fields.find((field) => {
      if (field === "clockId")
        return !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(clockId);
      const parsed = parseU64(options[field]);
      return (
        parsed === undefined || (field !== "originMonoNs" && parsed === 0n)
      );
    });
    if (invalid) {
      setInputIssue(invalid);
      optionsForm.current
        ?.querySelector<HTMLInputElement>('[name="' + invalid + '"]')
        ?.focus();
      return;
    }
    const window: Record<string, string> = { kind, length, step };
    if (kind === "time")
      Object.assign(window, { clockId, originMonoNs, periodNs });
    const owner = new AbortController();
    pending.current = owner;
    setBusy(true);
    try {
      const report = await readAnalysisReport(
        host,
        target,
        archiveSha256,
        windowsAction,
        { ...grid, window },
        owner.signal,
      );
      if (!owner.signal.aborted) setResult(parseWindowsReport(report));
    } catch (reason) {
      if (!owner.signal.aborted) setError(reason);
    } finally {
      if (pending.current === owner) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function option(field: OptionField) {
    const control = id + "-" + field;
    const issue = inputIssue === field;
    return (
      <div className="grid min-w-0 content-start gap-1.5">
        <Label htmlFor={control} className="leading-snug">
          {t(`plugins.windows.${field}`)}
        </Label>
        <Input
          id={control}
          name={field}
          inputMode={field === "clockId" ? "text" : "numeric"}
          spellCheck={false}
          maxLength={field === "clockId" ? 64 : 20}
          value={options[field]}
          aria-invalid={issue || undefined}
          aria-describedby={issue ? id + "-options-issue" : undefined}
          onChange={(event) =>
            replaceOptions({ [field]: event.currentTarget.value })
          }
        />
      </div>
    );
  }

  return (
    <details className="border-t pt-4">
      <summary className="cursor-pointer text-base font-semibold">
        {t("plugins.windows.title")}
      </summary>
      <section
        aria-label={t("plugins.windows.title")}
        className="@container/statistics mt-3 grid min-w-0 gap-4"
      >
        <form className="grid min-w-0 gap-3" onSubmit={calculate}>
          <div className="grid min-w-0 gap-4 @min-[48rem]/statistics:grid-cols-[minmax(0,1fr)_minmax(16rem,0.8fr)]">
            <div className="grid min-w-0 content-start gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <Label htmlFor={id + "-samples"} className="leading-snug">
                  {t("plugins.windows.input")}
                </Label>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  disabled={busy || hasCustomSamples}
                  onClick={() => {
                    clearReport();
                    setText(exampleText);
                  }}
                >
                  {t("plugins.windows.example")}
                </Button>
              </div>
              <p id={id + "-help"} className="text-sm text-muted-foreground">
                {t("plugins.windows.help")}
              </p>
              <Textarea
                id={id + "-samples"}
                ref={editor}
                disabled={busy}
                spellCheck={false}
                maxLength={maxInputLength}
                value={text}
                className="min-h-36 min-w-0 font-mono text-xs"
                aria-invalid={inputIssue === "input" || undefined}
                aria-describedby={
                  id +
                  "-help" +
                  (inputIssue === "input" ? " " + id + "-samples-issue" : "")
                }
                onChange={(event) => {
                  setText(event.currentTarget.value);
                  clearReport();
                }}
              />
              {inputIssue === "input" && (
                <p
                  id={id + "-samples-issue"}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {t("plugins.xy.invalid")}
                </p>
              )}
            </div>
            <fieldset
              ref={optionsForm}
              disabled={busy}
              className="grid min-w-0 content-start gap-3"
            >
              <legend className="mb-2 flex min-h-7 items-center text-sm font-medium">
                {t("plugins.windows.settings")}
              </legend>
              <div className="grid gap-1.5">
                <Label htmlFor={id + "-kind"}>
                  {t("plugins.windows.kind")}
                </Label>
                <OptionsSelect
                  id={id + "-kind"}
                  className="h-8"
                  value={options.kind}
                  options={[
                    { value: "count", label: t("plugins.windows.count") },
                    { value: "time", label: t("plugins.windows.time") },
                  ]}
                  onValueChange={(kind) => replaceOptions({ kind })}
                />
              </div>
              <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] items-end gap-3">
                {option("length")}
                {option("step")}
              </div>
              <p className="text-sm text-muted-foreground">
                {t(
                  options.kind === "time"
                    ? "plugins.windows.nsHint"
                    : "plugins.windows.sampleHint",
                )}
              </p>
              {options.kind === "time" && (
                <>
                  {option("clockId")}
                  {option("originMonoNs")}
                  {option("periodNs")}
                </>
              )}
              {inputIssue && inputIssue !== "input" && (
                <p
                  id={id + "-options-issue"}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {t("plugins.windows.invalidSettings")}
                </p>
              )}
            </fieldset>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || !text.trim()}>
              {t("plugins.windows.run")}
            </Button>
            {busy && (
              <p role="status" className="text-sm text-muted-foreground">
                {t("plugins.windows.running")}
              </p>
            )}
          </div>
          <PluginError error={error} message="plugins.windows.failed" />
        </form>
        {result && <WindowsResult report={result} />}
      </section>
    </details>
  );
}

export default function WindowStatisticsLauncher(props: Props) {
  const { state } = useHost();
  return state.catalog.some(
    (action) =>
      action.actionId === windowsAction && action.targetKinds.includes("host"),
  ) ? (
    <WindowStatistics {...props} />
  ) : null;
}
