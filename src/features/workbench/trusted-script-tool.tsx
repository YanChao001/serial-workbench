import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ContractValidationError,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { readVerifiedFile } from "@/lib/host-reader";
import { nativeErrorText } from "@/lib/native-error";
import { isRecord } from "@/lib/settings-model";
import type { LocalScriptIntent } from "@/lib/tauri";
import type { HostContextValue } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { version as runtimeVersion } from "../../../resources/runtime/node-release.json";
import { operationText } from "./operation-text";

export const trustedScriptAction = "swb.builtin.automation.script";

type Access = {
  port: string;
  target: Target;
  sessionRevision: string;
  configurationRevision: string;
  run: NonNullable<HostContextValue["runConfirmedScript"]>;
};
type Draft = { source: string; language: "js" | "ts" };
type Confirmation = { scope: { key: string }; intent: LocalScriptIntent };
type Result = { operationId: string; text: string };
const initial: Draft = { source: "", language: "js" };
const encoder = new TextEncoder();

function pending(state: Operation["state"]) {
  return (
    state === "queued" || state === "running" || state === "cancel_requested"
  );
}

function matches(operation: Operation, target: Target) {
  return (
    operation.executionHostId === target.hostId &&
    operation.target.hostId === target.hostId &&
    operation.target.kind === "session" &&
    operation.target.id === target.id &&
    operation.target.sessionId === target.sessionId &&
    operation.target.sessionEpoch === target.sessionEpoch
  );
}

async function readResult(
  operation: Operation,
  read: HostContextValue["readFile"],
  signal: AbortSignal,
) {
  const reference =
    operation.result?.kind === "reference"
      ? operation.result.value.resultRef
      : undefined;
  if (
    reference?.kind !== "plugin_result" ||
    reference.hostId !== operation.executionHostId ||
    reference.id !== operation.operationId
  )
    throw new ContractValidationError(
      "Script result belongs to another operation",
    );
  const bytes = await readVerifiedFile(reference, read, signal);
  const result: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!isRecord(result))
    throw new ContractValidationError("Invalid script result");
  const logs: unknown = result.logs ?? [];
  if (
    !Array.isArray(logs) ||
    logs.length > 128 ||
    !logs.every((line: unknown) => typeof line === "string")
  )
    throw new ContractValidationError("Invalid script logs");
  if (result.kind === "failed" && typeof result.message === "string")
    return [...logs, result.message].join("\n");
  if (result.kind !== "completed" || !Object.hasOwn(result, "value"))
    throw new ContractValidationError("Invalid script result");
  return [...logs, JSON.stringify(result.value, null, 2)].join("\n");
}

export function TrustedScriptTool({
  access,
  target,
  hostId,
  actorId,
  operations,
  revealedOperationId,
  wait,
  read,
  cancel,
}: {
  access?: Access;
  target?: Target;
  hostId?: string;
  actorId?: string;
  operations: Operation[];
  revealedOperationId?: string;
  wait: HostContextValue["waitForOperation"];
  read: HostContextValue["readFile"];
  cancel?: (operation: Operation, signal: AbortSignal) => Promise<void>;
}) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [acceptedDraft, setAcceptedDraft] = useState(initial);
  const [preview, setPreview] = useState<Confirmation>();
  const [retry, setRetry] = useState<Confirmation>();
  const [operationId, setOperationId] = useState<string>();
  const [busy, setBusy] = useState<"preparing" | "submitting">();
  const [stopping, setStopping] = useState<string>();
  const [result, setResult] = useState<Result>();
  const [readFailure, setReadFailure] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [stopError, setStopError] = useState<{
    id: string;
    failure: unknown;
  }>();
  const sourceField = useRef<HTMLTextAreaElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const stopRequest = useRef<AbortController | null>(null);
  const scopeKey = access
    ? JSON.stringify([
        access.target.hostId,
        access.target.id,
        access.target.sessionId,
        access.target.sessionEpoch,
        access.sessionRevision,
        access.configurationRevision,
      ])
    : undefined;
  const scope = useMemo(
    () => (scopeKey ? { key: scopeKey } : undefined),
    [scopeKey],
  );
  const current = useRef({ scope, draft });
  current.current = { scope, draft };
  const byteCount = encoder.encode(draft.source).length;
  const oversize = byteCount > 65_536;
  const confirmation = preview?.scope === scope ? preview : undefined;
  const historical = revealedOperationId !== undefined;
  const matching = operations.filter(
    (candidate) =>
      candidate.actionId === trustedScriptAction &&
      candidate.executionHostId === hostId &&
      candidate.target.hostId === hostId &&
      candidate.actorId === actorId &&
      (revealedOperationId
        ? candidate.operationId === revealedOperationId
        : target && matches(candidate, target)),
  );
  const operation =
    matching.find(
      (candidate) =>
        candidate.operationId === operationId && pending(candidate.state),
    ) ??
    matching.reduce<Operation | undefined>((latest, candidate) => {
      if (!latest) return candidate;
      const active = pending(candidate.state);
      if (active !== pending(latest.state)) return active ? candidate : latest;
      return candidate.acceptedAt >= latest.acceptedAt ? candidate : latest;
    }, undefined);
  const active = operation && pending(operation.state);
  const waitingId = active ? operation.operationId : undefined;
  const reference =
    !active && operation?.result?.kind === "reference"
      ? operation.result.value.resultRef
      : undefined;
  const resultKey =
    reference && operation
      ? JSON.stringify([operation.operationId, reference])
      : undefined;

  useUnsavedWork({
    id,
    label: t("trustedScript.title"),
    dirty:
      !historical &&
      (draft.source !== acceptedDraft.source ||
        draft.language !== acceptedDraft.language),
    retainAfterUnmount: false,
    discard: () => setDraft(acceptedDraft),
  });
  useEffect(
    () => () => {
      request.current?.abort();
      stopRequest.current?.abort();
    },
    [],
  );

  const observe = useEffectEvent(async (signal: AbortSignal) => {
    if (!operation) return;
    try {
      await wait(operation, signal);
    } catch (failure) {
      if (
        !signal.aborted &&
        (!isRecord(failure) || !("operationState" in failure))
      )
        setError(failure);
    }
  });
  useEffect(() => {
    if (!waitingId) return;
    const controller = new AbortController();
    void observe(controller.signal);
    return () => controller.abort();
  }, [waitingId]);

  const load = useEffectEvent(async (key: string, signal: AbortSignal) => {
    if (!operation) return;
    try {
      const text = await readResult(operation, read, signal);
      if (!signal.aborted) setResult({ operationId: key, text });
    } catch {
      if (!signal.aborted) setReadFailure(key);
    }
  });
  useEffect(() => {
    if (!resultKey) return;
    const controller = new AbortController();
    void load(resultKey, controller.signal);
    return () => controller.abort();
  }, [resultKey]);

  function update(next: Draft) {
    setDraft(next);
    setPreview(undefined);
    setRetry(undefined);
    setError(undefined);
  }
  async function review() {
    if (!access || !scope || request.current || oversize || active) return;
    if (!draft.source.trim()) {
      sourceField.current?.focus();
      return;
    }
    if (retry?.scope === scope) {
      setError(undefined);
      setPreview(retry);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy("preparing");
    setError(undefined);
    try {
      const bytes = encoder.encode(
        "serial-workbench-script-v1\0" + draft.language + "\0" + draft.source,
      );
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes),
      );
      if (
        controller.signal.aborted ||
        current.current.scope !== scope ||
        current.current.draft !== draft
      )
        return;
      const sourceSha256 = Array.from(digest, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      setPreview({
        scope,
        intent: {
          requestId: crypto.randomUUID(),
          target: access.target,
          language: draft.language,
          source: draft.source,
          sourceSha256,
          sessionRevision: access.sessionRevision,
          configurationRevision: access.configurationRevision,
        },
      });
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(undefined);
    }
  }

  async function run() {
    if (!access || !confirmation || request.current || active) return;
    const controller = new AbortController();
    request.current = controller;
    setPreview(undefined);
    setBusy("submitting");
    try {
      const admitted = await access.run(confirmation.intent, controller.signal);
      if (controller.signal.aborted) return;
      if (
        admitted.actionId !== trustedScriptAction ||
        admitted.actorId !== actorId ||
        admitted.requestId !== confirmation.intent.requestId ||
        !matches(admitted, confirmation.intent.target)
      )
        throw new ContractValidationError(
          "Script admission belongs to another request",
        );
      setOperationId(admitted.operationId);
      setAcceptedDraft(draft);
      setRetry(undefined);
    } catch (failure) {
      if (
        !controller.signal.aborted &&
        current.current.scope === scope &&
        current.current.draft === draft
      ) {
        setError(failure);
        setRetry(confirmation);
      }
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(undefined);
    }
  }

  async function stop() {
    if (
      !cancel ||
      !operation ||
      !active ||
      stopRequest.current ||
      operation.state === "cancel_requested"
    )
      return;
    const controller = new AbortController();
    stopRequest.current = controller;
    setStopping(operation.operationId);
    setStopError(undefined);
    try {
      await cancel(operation, controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted)
        setStopError({ id: operation.operationId, failure });
    } finally {
      if (stopRequest.current === controller) stopRequest.current = null;
      if (!controller.signal.aborted) setStopping(undefined);
    }
  }

  return (
    <div className="grid min-w-0 gap-4 py-2 @container/script">
      {!historical && (
        <>
          <div className="grid min-w-0 items-start gap-2 @min-[26rem]/script:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <p className="wrap-anywhere text-sm">
                {t("trustedScript.target")} · {access?.port ?? "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("trustedScript.runtime", { version: runtimeVersion })}
              </p>
            </div>
            <label className="flex min-w-0 items-center gap-2 text-sm">
              <span className="shrink-0 whitespace-nowrap">
                {t("trustedScript.language")}
              </span>
              <select
                className="min-w-0 rounded-md border border-input bg-background px-2 py-1"
                value={draft.language}
                onChange={(event) =>
                  update({
                    ...draft,
                    language: event.target.value === "ts" ? "ts" : "js",
                  })
                }
              >
                <option value="js">JavaScript</option>
                <option value="ts">TypeScript</option>
              </select>
            </label>
          </div>
          <div className="grid min-w-0 gap-1.5">
            <label htmlFor={id}>{t("trustedScript.source")}</label>
            <Textarea
              id={id}
              ref={sourceField}
              value={draft.source}
              className="min-h-28 max-h-[40dvh] min-w-0 resize-y font-mono"
              aria-describedby={id + "-bytes"}
              aria-invalid={oversize}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              onChange={(event) =>
                update({ ...draft, source: event.target.value })
              }
            />
            <p
              id={id + "-bytes"}
              className="text-end text-xs text-muted-foreground"
            >
              {oversize
                ? t("trustedScript.limit")
                : t("trustedScript.bytes", { count: byteCount })}
            </p>
          </div>
          {!access && (
            <p className="text-sm text-muted-foreground">
              {t("trustedScript.unavailable")}
            </p>
          )}
        </>
      )}
      {error !== undefined && (
        <p role="alert" className="wrap-anywhere text-sm text-destructive">
          {nativeErrorText(error, t)}
        </p>
      )}
      {operation && (
        <section
          aria-labelledby={id + "-output"}
          className="grid min-w-0 gap-2"
        >
          <h3 id={id + "-output"} className="text-sm font-medium">
            {t("trustedScript.output")}
          </h3>
          {stopError?.id === operation.operationId && active && (
            <p role="alert" className="wrap-anywhere text-sm text-destructive">
              {nativeErrorText(stopError.failure, t)}
            </p>
          )}
          <p role="status" className="text-sm">
            {operationText(t, (code) => code ?? "").states[operation.state]}
          </p>
          {operation.error && operation.state !== "cancelled" && (
            <p className="wrap-anywhere text-sm text-destructive">
              {nativeErrorText(operation.error, t)}
            </p>
          )}
          {resultKey && result?.operationId === resultKey && (
            <pre className="max-h-[30dvh] overflow-auto rounded-md border p-2 text-xs wrap-anywhere whitespace-pre-wrap">
              {result.text}
            </pre>
          )}
          {resultKey && readFailure === resultKey && (
            <p role="alert">{t("trustedScript.readError")}</p>
          )}
        </section>
      )}
      <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 rounded-md bg-background/70 py-1 backdrop-blur-sm">
        {active && cancel && (
          <Button
            variant="outline"
            disabled={
              stopping === operation.operationId ||
              operation.state === "cancel_requested"
            }
            onClick={() => void stop()}
          >
            {t("trustedScript.stop")}
          </Button>
        )}
        {!historical && (
          <Button
            disabled={!access || oversize || Boolean(busy) || Boolean(active)}
            onClick={() => void review()}
          >
            {busy === "preparing"
              ? t("trustedScript.staging")
              : busy === "submitting"
                ? t("trustedScript.submitting")
                : retry?.scope === scope && retry
                  ? t("trustedScript.retry")
                  : t("trustedScript.review")}
          </Button>
        )}
      </div>
      <Dialog
        open={confirmation !== undefined}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined);
        }}
      >
        <DialogContent
          showCloseButton={false}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            backButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (sourceField.current) {
              event.preventDefault();
              sourceField.current.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("trustedScript.confirm")}</DialogTitle>
            <DialogDescription>{t("trustedScript.trust")}</DialogDescription>
          </DialogHeader>
          <div className="grid min-w-0 gap-1 text-sm">
            <p className="wrap-anywhere">
              {t("trustedScript.target")} · {access?.port}
            </p>
            <p>
              {t("trustedScript.language")} ·{" "}
              {confirmation?.intent.language === "ts"
                ? "TypeScript"
                : "JavaScript"}
            </p>
            <p>{t("trustedScript.digest")}</p>
            <code className="wrap-anywhere text-xs">
              {confirmation?.intent.sourceSha256}
            </code>
          </div>
          <DialogFooter>
            <Button
              ref={backButton}
              variant="outline"
              onClick={() => setPreview(undefined)}
            >
              {t("trustedScript.back")}
            </Button>
            <Button onClick={() => void run()}>{t("trustedScript.run")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
