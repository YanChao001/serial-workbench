import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  CaptureRedactionPreviewParams,
  CaptureRedactionPreviewResult,
  CaptureRedactionRule,
} from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isRecord } from "@/lib/settings-model";
import { nativeErrorCode } from "@/lib/native-error";

export type RedactionRuleDraft = CaptureRedactionRule & { id: number };
export type RedactionPreview = (
  params: CaptureRedactionPreviewParams,
  signal: AbortSignal,
) => Promise<CaptureRedactionPreviewResult>;
export type CaptureRedactionLabels = {
  rules: string;
  edit: string;
  preview: string;
  pattern: string;
  replacement: string;
  add: string;
  remove: string;
  sample: string;
  run: string;
  result: string;
  replacements: (count: string) => string;
  invalidRule: string;
};

const maxRules = 16;
const maxPatternBytes = 256;
const maxReplacementBytes = 128;
const encoder = new TextEncoder();
export const emptyRedactionRules: readonly RedactionRuleDraft[] = [
  { id: 0, pattern: "", replacement: "" },
];

export function redactionRuleParams(rules: readonly RedactionRuleDraft[]) {
  return rules.map(({ pattern, replacement }) => ({ pattern, replacement }));
}

// Host validates Rust regex syntax and budgets at preview and at start.
export function redactionRulesReady(rules: readonly RedactionRuleDraft[]) {
  return (
    rules.length > 0 &&
    rules.length <= maxRules &&
    rules.every(
      ({ pattern, replacement }) =>
        pattern.length > 0 &&
        !exceeds(pattern, maxPatternBytes) &&
        !exceeds(replacement, maxReplacementBytes),
    )
  );
}

function exceeds(text: string, maxBytes: number) {
  return encoder.encode(text).length > maxBytes;
}

export function redactionRuleIndex(reason: unknown): number | undefined {
  // HostRequestError wraps the protocol error; operation failures expose it directly.
  if (!isRecord(reason) || !isRecord(reason.details)) return;
  const payload = isRecord(reason.details.details)
    ? reason.details.details
    : reason.details;
  const index = payload.ruleIndex;
  if (
    typeof index === "number" &&
    Number.isInteger(index) &&
    index >= 1 &&
    index <= maxRules
  )
    return index - 1;
}

export function CaptureRedactionFields({
  rules,
  onRulesChange,
  labels,
  preview,
  disabled,
  rejectedRule,
  formatError,
}: {
  rules: readonly RedactionRuleDraft[];
  onRulesChange: (rules: readonly RedactionRuleDraft[]) => void;
  labels: CaptureRedactionLabels;
  preview: RedactionPreview;
  disabled: boolean;
  rejectedRule?: number;
  formatError: (code?: string) => string;
}) {
  const [tab, setTab] = useState("rules");
  const [sample, setSample] = useState("token=demo-123\n");
  const [result, setResult] = useState<CaptureRedactionPreviewResult>();
  const [error, setError] = useState<string>();
  const [invalidRule, setInvalidRule] = useState<number>();
  const [pending, setPending] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const focusRule = useRef<number | undefined>(undefined);
  const nextId = useRef(Math.max(0, ...rules.map((rule) => rule.id)) + 1);
  const invalid = rejectedRule ?? invalidRule;

  const resetPreview = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setPending(false);
    setResult(undefined);
    setError(undefined);
    setInvalidRule(undefined);
  }, []);
  useEffect(() => () => inFlight.current?.abort(), []);
  useEffect(() => resetPreview(), [rules, resetPreview]);
  useEffect(() => {
    if (disabled) resetPreview();
  }, [disabled, resetPreview]);
  useLayoutEffect(() => {
    if (rejectedRule === undefined || disabled || !rules[rejectedRule]) return;
    focusRule.current = rules[rejectedRule].id;
    setTab("rules");
  }, [rejectedRule, rules, disabled]);
  const focusPattern = useCallback(
    (input: HTMLInputElement | null | undefined) => {
      if (!input || input.dataset.rulePattern !== String(focusRule.current))
        return;
      input.focus();
      if (document.activeElement === input) focusRule.current = undefined;
    },
    [],
  );
  useLayoutEffect(() => {
    if (tab !== "rules" || focusRule.current === undefined || disabled) return;
    focusPattern(
      root.current?.querySelector<HTMLInputElement>(
        `[data-rule-pattern="${focusRule.current}"]`,
      ),
    );
  }, [tab, rules, invalid, disabled, focusPattern]);

  function changeRules(value: readonly RedactionRuleDraft[]) {
    resetPreview();
    onRulesChange(value);
  }
  function updateRule(id: number, patch: Partial<CaptureRedactionRule>) {
    changeRules(
      rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    );
  }
  function removeRule(position: number) {
    if (rules.length === 1) {
      focusRule.current = 0;
      changeRules(emptyRedactionRules);
      return;
    }
    focusRule.current = (rules[position + 1] ?? rules[position - 1])?.id;
    changeRules(rules.filter((_, index) => index !== position));
  }
  async function runPreview() {
    if (
      inFlight.current ||
      disabled ||
      !redactionRulesReady(rules) ||
      !sample.length
    )
      return;
    resetPreview();
    const controller = new AbortController();
    inFlight.current = controller;
    setPending(true);
    try {
      const value = await preview(
        { rules: redactionRuleParams(rules), sample },
        controller.signal,
      );
      if (!controller.signal.aborted) setResult(value);
    } catch (reason: unknown) {
      if (controller.signal.aborted) return;
      const position = redactionRuleIndex(reason);
      if (position !== undefined && rules[position]) {
        setInvalidRule(position);
        focusRule.current = rules[position].id;
        setTab("rules");
      } else {
        setError(formatError(nativeErrorCode(reason)));
      }
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setPending(false);
      }
    }
  }

  return (
    <div ref={root} className="workbench-redaction-fields">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label={labels.rules}>
          <TabsTrigger value="rules">{labels.edit}</TabsTrigger>
          <TabsTrigger value="preview">{labels.preview}</TabsTrigger>
        </TabsList>
        <div
          className="workbench-redaction-layout text-sm"
          data-result={tab === "preview" || !!result}
        >
          <TabsContent value="rules" className="workbench-form-fields">
            {rules.map((rule, position) => {
              const patternTooLong = exceeds(rule.pattern, maxPatternBytes);
              const replacementTooLong = exceeds(
                rule.replacement,
                maxReplacementBytes,
              );
              return (
                <div
                  key={rule.id}
                  role="group"
                  aria-label={`${labels.rules} ${position + 1}`}
                  className="workbench-redaction-rule"
                >
                  <label className="workbench-form-row">
                    <span>{labels.pattern}</span>
                    <Input
                      ref={focusPattern}
                      data-rule-pattern={rule.id}
                      className="font-mono"
                      value={rule.pattern}
                      spellCheck={false}
                      maxLength={maxPatternBytes}
                      aria-invalid={invalid === position || patternTooLong}
                      onChange={(event) =>
                        updateRule(rule.id, { pattern: event.target.value })
                      }
                    />
                  </label>
                  <label className="workbench-form-row">
                    <span>{labels.replacement}</span>
                    <Input
                      className="font-mono"
                      value={rule.replacement}
                      spellCheck={false}
                      maxLength={maxReplacementBytes}
                      aria-invalid={replacementTooLong}
                      onChange={(event) =>
                        updateRule(rule.id, { replacement: event.target.value })
                      }
                    />
                  </label>
                  {(invalid === position ||
                    patternTooLong ||
                    replacementTooLong) && (
                    <p role="alert" className="text-destructive">
                      {labels.invalidRule}
                    </p>
                  )}
                  <div className="workbench-toolbar justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => removeRule(position)}
                    >
                      {labels.remove}
                    </Button>
                  </div>
                </div>
              );
            })}
            <div className="workbench-toolbar">
              <Button
                size="sm"
                variant="outline"
                disabled={rules.length >= maxRules}
                onClick={() => {
                  const id = nextId.current++;
                  focusRule.current = id;
                  changeRules([...rules, { id, pattern: "", replacement: "" }]);
                }}
              >
                {labels.add}
              </Button>
            </div>
          </TabsContent>
          <TabsContent
            value="preview"
            className="workbench-form-fields"
            aria-busy={pending}
          >
            <label className="workbench-redaction-sample">
              <span>{labels.sample}</span>
              <Textarea
                className="font-mono"
                rows={4}
                maxLength={8192}
                spellCheck={false}
                value={sample}
                onChange={(event) => {
                  resetPreview();
                  setSample(event.target.value);
                }}
              />
            </label>
            <div className="workbench-toolbar">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  pending || !redactionRulesReady(rules) || !sample.length
                }
                onClick={() => void runPreview()}
              >
                {labels.run}
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </TabsContent>
          {(tab === "preview" || result) && (
            <div className="workbench-redaction-sample" aria-live="polite">
              <span>{labels.result}</span>
              <pre
                aria-label={labels.result}
                className="workbench-redaction-output"
              >
                {result?.text}
              </pre>
              {result && (
                <span className="text-muted-foreground">
                  {labels.replacements(result.replacements)}
                </span>
              )}
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );
}
