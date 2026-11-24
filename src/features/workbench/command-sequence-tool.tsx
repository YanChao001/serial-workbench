import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ContractValidationError,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { nativeErrorCode, nativeErrorText } from "@/lib/native-error";
import { isTauri, saveTextExport } from "@/lib/tauri";
import type { HostContextValue } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  commandSequenceMaxBytes,
  CommandSequenceError,
  compileCommandSequence,
  type CommandSequenceStep,
} from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-model";
import {
  readSequenceResult,
  sameSequence,
  type SequenceActionId,
  type SequenceResult,
} from "./sequence-workbench-model";

const example = JSON.stringify(
  {
    version: 1,
    variables: { payload: "41" },
    steps: [
      {
        kind: "send",
        hex: "${payload}",
        expect: {
          hex: "${payload}",
          timeoutMs: 750,
          onMatch: [{ kind: "send", hex: "42" }],
          onTimeout: [{ kind: "send", hex: "58" }],
        },
      },
      { kind: "delay", milliseconds: 100 },
      { kind: "send", hex: "43" },
    ],
  },
  null,
  2,
);

export type CommandSequenceDraft = { definition: string; saved: string };

type Access = Pick<
  HostContextValue,
  "invoke" | "waitForOperation" | "readFile"
> & {
  target: Target;
  port: string;
  readCursor: (signal: AbortSignal) => Promise<string>;
  cancel?: (operation: Operation, signal: AbortSignal) => Promise<void>;
};

type Run =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "accepted"; operation: Operation }
  | { phase: "finished"; operationId: string; result: SequenceResult }
  | {
      phase: "failed";
      operationId?: string;
      code?: string;
      cancelled: boolean;
      unobserved?: Operation;
    };

function pending(operation: Operation) {
  return (
    operation.state === "queued" ||
    operation.state === "running" ||
    operation.state === "cancel_requested"
  );
}

function preview(definition: string) {
  if (!definition.trim()) return {};
  try {
    return { plan: compileCommandSequence(definition) };
  } catch (error) {
    if (error instanceof CommandSequenceError) return { error };
    throw error;
  }
}

function Plan({ steps }: { steps: readonly CommandSequenceStep[] }) {
  const { t } = useI18n();
  return (
    <ol className="grid list-decimal gap-2 ps-6 text-sm marker:text-muted-foreground">
      {steps.map((step, index) => (
        <li key={index} className="min-w-0">
          {step.kind === "delay" ? (
            <span>
              {t("commandSequence.previewDelay", { ms: step.milliseconds })}
            </span>
          ) : (
            <>
              <div>
                {t("commandSequence.previewSend")}{" "}
                <code className="break-all">{formatHex(step.bytes)}</code>
              </div>
              {step.writeWaitMs !== undefined && (
                <p className="text-muted-foreground">
                  {t("commandSequence.previewWriteWait", {
                    ms: step.writeWaitMs,
                  })}
                </p>
              )}
              {step.expect && (
                <div className="mt-1 space-y-1 border-s ps-3 text-muted-foreground">
                  <p>
                    {t("commandSequence.previewExpect", {
                      ms: step.expect.timeoutMs,
                    })}{" "}
                    <code className="break-all text-foreground">
                      {formatHex(step.expect.bytes)}
                    </code>
                  </p>
                  {step.expect.retry.length > 0 && (
                    <div>
                      <p>{t("commandSequence.previewRetry")}</p>
                      <ol className="list-decimal space-y-1 ps-6">
                        {step.expect.retry.map((retry) => (
                          <li key={retry.path}>
                            {t("commandSequence.previewSend")}{" "}
                            <code className="break-all text-foreground">
                              {formatHex(retry.bytes)}
                            </code>
                            {" · "}
                            {t("commandSequence.previewRetryReply")}{" "}
                            <code className="break-all text-foreground">
                              {formatHex(retry.response)}
                            </code>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {step.expect.onMatch && (
                    <details>
                      <summary className="cursor-pointer">
                        {t("commandSequence.previewMatch")}
                      </summary>
                      <Plan steps={step.expect.onMatch} />
                    </details>
                  )}
                  {step.expect.onTimeout && (
                    <details>
                      <summary className="cursor-pointer">
                        {t("commandSequence.previewTimeout")}
                      </summary>
                      <Plan steps={step.expect.onTimeout} />
                    </details>
                  )}
                </div>
              )}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

export function CommandSequenceTool({
  access,
  actionId,
  operations,
  beforeReplace,
  draft,
  onDraftChange,
}: {
  access?: Access;
  actionId?: SequenceActionId;
  operations: readonly Operation[];
  beforeReplace: () => Promise<boolean>;
  draft: CommandSequenceDraft;
  onDraftChange: Dispatch<SetStateAction<CommandSequenceDraft>>;
}) {
  const { t } = useI18n();
  const id = useId();
  const { definition, saved } = draft;
  const native = isTauri();
  const setDefinition = (value: string) =>
    onDraftChange((previous) => ({ ...previous, definition: value }));
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const [cancelling, setCancelling] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [fileBusy, setFileBusy] = useState(false);
  const fileRequest = useRef(false);
  const command = useRef<AbortController | null>(null);
  const stopping = useRef<AbortController | null>(null);
  const localFile = useRef<HTMLInputElement | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      command.current?.abort();
      stopping.current?.abort();
    };
  }, []);

  const { plan, error } = useMemo(() => preview(definition), [definition]);
  const active = access
    ? operations.reduce<Operation | undefined>(
        (last, operation) =>
          sameSequence(operation, access.target) && pending(operation)
            ? operation
            : last,
        undefined,
      )
    : undefined;
  const unobserved = run.phase === "failed" ? run.unobserved : undefined;
  const previousId =
    run.phase === "finished" || run.phase === "failed"
      ? run.operationId
      : undefined;
  const waiting = active?.operationId === previousId ? undefined : active;
  const adopt =
    !unobserved && run.phase !== "starting" && run.phase !== "accepted"
      ? waiting
      : undefined;
  useEffect(() => {
    if (adopt)
      setRun((previous) =>
        previous.phase === "starting" || previous.phase === "accepted"
          ? previous
          : { phase: "accepted", operation: adopt },
      );
  }, [adopt]);
  const watched = run.phase === "accepted" ? run.operation : adopt;
  const tracked = watched ?? unobserved;
  const projected =
    tracked &&
    operations.find(
      (operation) =>
        operation.operationId === tracked.operationId &&
        sameSequence(operation, tracked.target),
    );
  const current = projected ?? tracked;
  const busy =
    fileBusy ||
    run.phase === "starting" ||
    watched !== undefined ||
    (current !== undefined && pending(current));
  const watch = useRef({ watched, access });
  watch.current = { watched, access };
  const watchId = watched?.operationId;
  useEffect(() => {
    if (!watchId) return;
    const { watched, access } = watch.current;
    if (!watched || !access || watched.operationId !== watchId) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      let terminal: Operation | undefined;
      try {
        terminal = await access.waitForOperation(watched, signal);
        const result = await readSequenceResult(
          watched,
          terminal,
          access.target,
          access.readFile,
          signal,
        );
        signal.throwIfAborted();
        setRun({ phase: "finished", operationId: watchId, result });
      } catch (error) {
        if (signal.aborted) return;
        const operationState =
          typeof error === "object" &&
          error !== null &&
          "operationState" in error
            ? error.operationState
            : undefined;
        setRun({
          phase: "failed",
          operationId: watchId,
          code: nativeErrorCode(error),
          cancelled: operationState === "cancelled",
          unobserved:
            terminal || typeof operationState === "string"
              ? undefined
              : watched,
        });
      }
    })();
    return () => controller.abort();
  }, [watchId]);

  useUnsavedWork({
    id,
    label: t("commandSequence.definition"),
    dirty: definition !== saved,
    retainAfterUnmount: false,
    discard: () => setDefinition(saved),
  });

  async function start() {
    if (
      !access ||
      !actionId ||
      !plan ||
      busy ||
      command.current ||
      fileRequest.current
    )
      return;
    const controller = new AbortController();
    command.current = controller;
    const { signal } = controller;
    setRun({ phase: "starting" });
    setNotice(undefined);
    setCancelling(undefined);
    try {
      const startEventSeq = await access.readCursor(signal);
      signal.throwIfAborted();
      const accepted = await access.invoke(
        {
          actionId,
          target: access.target,
          params: { definition, startEventSeq },
          executionMode: "independent",
        },
        signal,
      );
      signal.throwIfAborted();
      if (
        accepted.actionId !== actionId ||
        accepted.executionMode !== "independent" ||
        !sameSequence(accepted, access.target)
      )
        throw new ContractValidationError(
          "Command sequence belongs to another session",
        );
      setRun({ phase: "accepted", operation: accepted });
    } catch (error) {
      if (!signal.aborted)
        setRun({
          phase: "failed",
          code: nativeErrorCode(error),
          cancelled: false,
        });
    } finally {
      if (command.current === controller) command.current = null;
    }
  }

  async function cancel() {
    if (
      !access?.cancel ||
      !current ||
      !pending(current) ||
      stopping.current ||
      cancelling === current.operationId
    )
      return;
    const controller = new AbortController();
    stopping.current = controller;
    setCancelling(current.operationId);
    setNotice(undefined);
    try {
      await access.cancel(current, controller.signal);
      if (!controller.signal.aborted && !watchId)
        setRun({ phase: "accepted", operation: current });
    } catch (error) {
      if (!controller.signal.aborted) {
        setCancelling(undefined);
        setNotice(nativeErrorText(error, t));
      }
    } finally {
      if (stopping.current === controller) stopping.current = null;
    }
  }

  async function open(file: File) {
    const signal = lifetime.current?.signal;
    if (!signal || busy || fileRequest.current || command.current) return;
    if (!/\.json$/i.test(file.name) || file.size > commandSequenceMaxBytes) {
      setNotice(t("commandSequence.fileInvalid"));
      return;
    }
    fileRequest.current = true;
    setFileBusy(true);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (signal.aborted) return;
      compileCommandSequence(text);
      if (!(await beforeReplace()) || signal.aborted) return;
      onDraftChange({ definition: text, saved: text });
      setNotice(undefined);
    } catch (error) {
      if (!signal.aborted)
        setNotice(
          error instanceof CommandSequenceError
            ? t("commandSequence.invalid", { path: error.path })
            : t("commandSequence.fileInvalid"),
        );
    } finally {
      fileRequest.current = false;
      if (!signal.aborted) setFileBusy(false);
    }
  }

  async function save() {
    const signal = lifetime.current?.signal;
    if (!plan || !signal || fileRequest.current || command.current) return;
    fileRequest.current = true;
    setFileBusy(true);
    try {
      if (
        (await saveTextExport("command-sequence.json", definition)) &&
        native &&
        !signal.aborted
      )
        onDraftChange((previous) => ({ ...previous, saved: definition }));
    } catch (error) {
      if (!signal.aborted) setNotice(nativeErrorText(error, t));
    } finally {
      fileRequest.current = false;
      if (!signal.aborted) setFileBusy(false);
    }
  }

  async function replaceDefinition(choose: () => void) {
    const signal = lifetime.current?.signal;
    if (
      !busy &&
      signal &&
      (await beforeReplace()) &&
      !signal.aborted &&
      !command.current &&
      !fileRequest.current
    )
      choose();
  }

  return (
    <section className="grid gap-4">
      <p className="min-w-0 break-all text-sm">
        {access
          ? t("repeatSend.destination", {
              port: access.port,
              epoch: access.target.sessionEpoch ?? "",
            })
          : t("repeatSend.selectSession")}
      </p>
      {!actionId && (
        <p className="text-sm text-muted-foreground">
          {t("commandSequence.unavailable")}
        </p>
      )}
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="grid min-w-0 content-start gap-2">
          <label className="text-sm font-medium" htmlFor={id + "-definition"}>
            {t("commandSequence.definition")}
          </label>
          <Textarea
            id={id + "-definition"}
            className="min-h-48 font-mono text-xs"
            maxLength={commandSequenceMaxBytes}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            aria-invalid={!!error}
            aria-describedby={error ? id + "-error" : undefined}
            value={definition}
            onChange={(event) => setDefinition(event.currentTarget.value)}
          />
          {error && (
            <div id={id + "-error"} className="text-sm text-destructive">
              <p>{t("commandSequence.invalid", { path: error.path })}</p>
              <details className="text-xs">
                <summary className="cursor-pointer">
                  {t("commandSequence.details")}
                </summary>
                {error.message}
              </details>
            </div>
          )}
          <input
            type="file"
            accept=".json,application/json"
            hidden
            ref={localFile}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void open(file);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => localFile.current?.click()}
            >
              {t("commandSequence.open")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !plan}
              onClick={() => void save()}
            >
              {t(native ? "commandSequence.save" : "commandSequence.download")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                void replaceDefinition(() => setDefinition(example))
              }
            >
              {t("commandSequence.example")}
            </Button>
          </div>
        </div>
        <div
          className="min-w-0 rounded-md border p-3"
          aria-labelledby={id + "-preview"}
        >
          <h3 id={id + "-preview"} className="mb-3 text-sm font-medium">
            {t("commandSequence.preview")}
          </h3>
          {plan ? (
            <div
              className="max-h-72 overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              tabIndex={0}
              aria-labelledby={id + "-preview"}
            >
              <Plan steps={plan} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("commandSequence.previewEmpty")}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!access || !actionId || !plan || busy}
          onClick={() => void start()}
        >
          {t("commandSequence.start")}
        </Button>
        {access && unobserved && current && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRun({ phase: "accepted", operation: current })}
          >
            {t("commandSequence.retryObservation")}
          </Button>
        )}
        {access?.cancel && current && pending(current) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              cancelling === current.operationId ||
              current.state === "cancel_requested"
            }
            onClick={() => void cancel()}
          >
            {t("commandSequence.cancel")}
          </Button>
        )}
      </div>
      {notice && (
        <p className="text-sm text-destructive" role="alert">
          {notice}
        </p>
      )}
      <div role="status" className="grid gap-1 text-sm">
        {run.phase === "starting" && <p>{t("commandSequence.submitting")}</p>}
        {current && (
          <>
            <p>
              {t(
                cancelling === current.operationId ||
                  current.state === "cancel_requested"
                  ? "repeatSend.cancelling"
                  : "commandSequence.running",
              )}
            </p>
            {current.progress && (
              <p>
                {t("commandSequence.progress", {
                  count: current.progress.completed,
                })}
              </p>
            )}
          </>
        )}
        {run.phase === "failed" && (
          <p>
            {run.cancelled
              ? t("repeatSend.cancelled")
              : nativeErrorText({ code: run.code }, t)}
          </p>
        )}
        {run.phase === "finished" && (
          <>
            <p>
              {run.result.outcome === "completed"
                ? t("commandSequence.completed")
                : t(`repeatSend.outcome.${run.result.outcome}`)}
            </p>
            <p>
              {t("commandSequence.progress", {
                count: run.result.completedSteps,
              })}
            </p>
            {run.result.stoppedAt && (
              <p>
                {t("commandSequence.stoppedAt", { path: run.result.stoppedAt })}
              </p>
            )}
          </>
        )}
        {(current ||
          (run.phase === "finished" && run.operationId) ||
          (run.phase === "failed" && run.operationId)) && (
          <p className="break-all text-muted-foreground">
            {t("repeatSend.task", {
              id:
                current?.operationId ??
                (run.phase === "finished" || run.phase === "failed"
                  ? (run.operationId ?? "")
                  : ""),
            })}
          </p>
        )}
      </div>
      {run.phase === "finished" && run.result.attempts.length > 0 && (
        <details className="rounded-md border px-3 py-2 text-sm">
          <summary className="cursor-pointer">
            {t("commandSequence.receipts")}
          </summary>
          <ul className="grid gap-2 py-2">
            {run.result.attempts.map((attempt) => (
              <li key={attempt.operationId} className="break-all">
                <p>
                  <code>{attempt.path}</code> ?{" "}
                  {t(`repeatSend.outcome.${attempt.outcome}`)}
                </p>
                <code className="text-xs text-muted-foreground">
                  {attempt.operationId}
                </code>
                {attempt.source && (
                  <p>
                    {t("commandSequence.rxRange", {
                      start: attempt.source.byteStart,
                      end: attempt.source.byteEnd,
                    })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
