import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Workflow } from "lucide-react";
import { TX_MAX_BYTES } from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { TextSendPreview } from "@/lib/text-encoding";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  runSendPreprocess,
  SEND_PREPROCESS_DEFINITION_LIMIT,
  SendPreprocessError,
  type SendPreprocessQuery,
} from "./send-preprocess";
import { WorkbenchIconButton } from "./workbench-icon-button";
import type { WorkbenchLabels } from "./labels";

const example = '[{"kind":"json","field":"data","format":"text"}]';

type Input = { prepared: TextSendPreview; ending: Uint8Array };
type Snapshot = {
  identity: string;
  revision: string | undefined;
  enabled: boolean;
  definition: string;
  input: Input | undefined;
  query: SendPreprocessQuery | undefined;
};
type Calculation = { snapshot: Snapshot } & (
  | { status: "running" }
  | { status: "ready"; bytes: Uint8Array }
  | { status: "failed"; error: SendPreprocessError }
);

export function useSendPreprocess(
  identity: string,
  revision: string | undefined,
  input: Input | undefined,
  query?: SendPreprocessQuery,
) {
  const initial = { identity, definition: "", enabled: false };
  const [settings, setSettings] = useState(initial);
  const [calculation, setCalculation] = useState<Calculation>();
  const active = useRef<AbortController | undefined>(undefined);
  const state = settings.identity === identity ? settings : initial;
  if (settings.identity !== identity) setSettings(initial);
  const { definition, enabled } = state;
  const snapshot = useMemo(
    () => ({ identity, revision, definition, enabled, input, query }),
    [identity, revision, definition, enabled, input, query],
  );
  const current = calculation?.snapshot === snapshot ? calculation : undefined;

  useLayoutEffect(
    () => () => {
      active.current?.abort();
      active.current = undefined;
    },
    [snapshot],
  );
  const cancel = useCallback(() => {
    if (!active.current) return;
    active.current.abort();
    active.current = undefined;
    setCalculation(undefined);
  }, []);
  const reset = useCallback(() => {
    cancel();
    setSettings({ identity, definition: "", enabled: false });
  }, [cancel, identity]);
  const setEnabled = useCallback(
    (value: boolean) =>
      setSettings((previous) => ({ ...previous, enabled: value })),
    [],
  );
  const setDefinition = useCallback(
    (value: string) =>
      setSettings((previous) => ({ ...previous, definition: value })),
    [],
  );
  const run = useCallback(async () => {
    if (active.current || !snapshot.enabled || !snapshot.input) return;
    const controller = new AbortController();
    active.current = controller;
    setCalculation({ snapshot, status: "running" });
    try {
      const { prepared, ending } = snapshot.input;
      const length = prepared.byteLength - ending.length;
      if (length > TX_MAX_BYTES) throw new SendPreprocessError("limit");
      const body = prepared.readBytes().subarray(0, length);
      const bytes = await runSendPreprocess(
        body,
        snapshot.definition,
        controller.signal,
        snapshot.query,
      );
      if (active.current === controller)
        setCalculation({ snapshot, status: "ready", bytes });
    } catch (error) {
      if (active.current === controller)
        setCalculation({
          snapshot,
          status: "failed",
          error:
            error instanceof SendPreprocessError
              ? error
              : new SendPreprocessError("encoding"),
        });
    } finally {
      if (active.current === controller) active.current = undefined;
    }
  }, [snapshot]);
  return useMemo(
    () => ({
      enabled,
      definition,
      canRun: enabled && !!input && !!definition.trim(),
      current,
      setEnabled,
      setDefinition,
      run,
      cancel,
      reset,
    }),
    [
      enabled,
      definition,
      input,
      current,
      setEnabled,
      setDefinition,
      run,
      cancel,
      reset,
    ],
  );
}

export function SendPreprocessSettings({
  preprocess,
  labels,
  final,
  disabled,
}: {
  preprocess: ReturnType<typeof useSendPreprocess>;
  labels: WorkbenchLabels["preprocess"];
  final?: TextSendPreview;
  disabled?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const { title } = labels;
  const {
    enabled,
    definition,
    canRun,
    current,
    setEnabled,
    setDefinition,
    cancel,
    reset,
  } = preprocess;
  const running = current?.status === "running";
  const error = current?.status === "failed" ? current.error : undefined;
  useUnsavedWork({
    id,
    label: title,
    dirty: !!definition,
    retainAfterUnmount: false,
    discard: reset,
  });
  const finalHex = useMemo(
    () => (open && final ? formatHex(final.readBytes()) : undefined),
    [open, final],
  );
  let status = enabled && !final ? labels.pending : undefined;
  if (running) status = labels.running;
  if (error) {
    const message = labels.errors[error.reason];
    status =
      error.step === undefined
        ? message
        : labels.stepError(error.step, message);
  }
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) cancel();
      }}
    >
      <PopoverTrigger asChild>
        <WorkbenchIconButton
          label={title}
          disabled={disabled}
          variant={enabled ? "secondary" : "ghost"}
        >
          <Workflow aria-hidden="true" />
        </WorkbenchIconButton>
      </PopoverTrigger>
      <PopoverContent
        aria-label={title}
        side="top"
        align="start"
        className="workbench-detail-popover grid max-h-[var(--radix-popover-content-available-height)] gap-2 overflow-auto"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={disabled}
            />
            {labels.enabled}
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setDefinition(example)}
          >
            {labels.example}
          </Button>
        </div>
        <label htmlFor={`${id}-definition`}>{labels.definition}</label>
        <Textarea
          id={`${id}-definition`}
          ref={input}
          value={definition}
          onChange={(event) => setDefinition(event.target.value)}
          disabled={disabled}
          maxLength={SEND_PREPROCESS_DEFINITION_LIMIT}
          aria-invalid={error?.reason === "definition" || undefined}
          aria-describedby={status ? `${id}-status` : undefined}
          spellCheck={false}
          className="font-mono"
          rows={3}
        />
        {status && (
          <p
            id={`${id}-status`}
            role="status"
            className={error ? "break-words text-destructive" : "break-words"}
          >
            {status}
          </p>
        )}
        <div>
          <Button
            type="button"
            size="sm"
            disabled={disabled || running || !canRun}
            onClick={() => void preprocess.run()}
          >
            {labels.preview}
          </Button>
        </div>
        {final && finalHex !== undefined && (
          <div
            className="grid min-w-0 gap-1"
            role="region"
            aria-labelledby={`${id}-final`}
          >
            <p id={`${id}-final`}>{labels.final(final.byteLength)}</p>
            <pre
              className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono"
              tabIndex={0}
            >
              {finalHex}
            </pre>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
