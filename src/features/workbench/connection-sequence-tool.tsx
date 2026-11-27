import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import {
  ContractValidationError,
  type OperationSummary,
  type OperationState,
  type SerialConfiguration,
  type Target,
} from "@serial-workbench/contracts";
import { formatHex, parseHex } from "@serial-workbench/host-client";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { nativeErrorText } from "@/lib/native-error";
import { requestOperationCancel } from "@/lib/operation-cancel";
import { rpcJsonObject } from "@/lib/rpc-json";
import type { HostContextValue } from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  builtinConnectionSequenceAction,
  compileConnectionSequence,
  connectionSequenceMaximumSteps,
  type ConnectionSequenceStep,
} from "../../../packages/plugin-sdk/examples/reference-automation/connection-sequence-model";
import {
  readConnectionSequenceResult,
  type ConnectionSequenceResult,
} from "./connection-sequence-result";
import { formatSerialLine } from "./serial-configuration";
import { operationText } from "./operation-text";
import { useToolAction } from "./transfer-capture-actions";

const kinds = ["line", "delay", "send", "ready"] as const;
type Kind = (typeof kinds)[number];
type StepDraft = { key: number } & (
  | { kind: "line"; line: "dtr" | "rts"; value: boolean }
  | { kind: "delay"; milliseconds: string }
  | { kind: "send"; hex: string }
  | { kind: "ready"; hex: string; timeoutMs: string }
);
type Draft = { beforeOpenMs: string; steps: StepDraft[] };
const emptyDraft: Draft = { beforeOpenMs: "0", steps: [] };

function newStep(key: number, kind: Kind): StepDraft {
  switch (kind) {
    case "line":
      return { key, kind, line: "dtr", value: false };
    case "delay":
      return { key, kind, milliseconds: "250" };
    case "send":
      return { key, kind, hex: "" };
    case "ready":
      return { key, kind, hex: "", timeoutMs: "1000" };
  }
}

function integer(value: string): number {
  return /^(0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
}

function stepInput(step: StepDraft): ConnectionSequenceStep {
  switch (step.kind) {
    case "line":
      return { kind: "line", line: step.line, value: step.value };
    case "delay":
      return { kind: "delay", milliseconds: integer(step.milliseconds) };
    case "send":
    case "ready": {
      const bytes = parseHex(step.hex);
      if (bytes.length > 256) throw new Error("Connection frame is too long");
      const bytesBase64 = btoa(String.fromCharCode(...bytes));
      return step.kind === "send"
        ? { kind: "send", bytesBase64 }
        : { kind: "ready", bytesBase64, timeoutMs: integer(step.timeoutMs) };
    }
  }
}

function draftPlan(draft: Draft, configuration: SerialConfiguration) {
  let row: number | undefined;
  try {
    const steps = draft.steps.map((step, index) => {
      row = index;
      return stepInput(step);
    });
    row = undefined;
    return {
      definition: compileConnectionSequence(
        { version: 1, beforeOpenMs: integer(draft.beforeOpenMs), steps },
        configuration.flowControl,
      ),
    };
  } catch (error) {
    const step =
      error instanceof Error
        ? /steps\[(\d+)\]/.exec(error.message)?.[1]
        : undefined;
    return { row: step === undefined ? row : Number(step) };
  }
}

function running(state: OperationState | undefined) {
  return (
    state === "running" || state === "queued" || state === "cancel_requested"
  );
}

export type ConnectionSequenceDevice = {
  hostId: string;
  deviceId: string;
  systemName: string;
};

export default function ConnectionSequenceTool({
  host,
  device,
  configuration,
  canOpen,
  revealedOperationId,
  inspectSession,
}: {
  host: HostContextValue;
  device?: ConnectionSequenceDevice;
  configuration: SerialConfiguration;
  canOpen: boolean;
  revealedOperationId?: string;
  inspectSession?: (target: Target) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const key = useRef(0);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [confirmedDraft, setConfirmedDraft] = useState<Draft>(emptyDraft);
  const [acceptedId, setAcceptedId] = useState<string>();
  const [permission, setPermission] = useState<{
    input: object;
    allowed: boolean;
  }>();
  const [report, setReport] = useState<{
    operationId: string;
    result?: ConnectionSequenceResult;
    error?: string;
  }>();
  const start = useToolAction((error) => nativeErrorText(error, t));
  const cancel = useToolAction((error) => nativeErrorText(error, t));
  const input = useMemo(
    () => draftPlan(draft, configuration),
    [draft, configuration],
  );
  const definition = input.definition;
  const hostId = device?.hostId;
  const deviceId = device?.deviceId;
  const check = useMemo(() => {
    if (!hostId || !deviceId || !definition || !canOpen) return;
    return {
      actionId: builtinConnectionSequenceAction,
      target: { hostId, kind: "device", id: deviceId },
      params: rpcJsonObject({ configuration, definition }),
    };
  }, [hostId, deviceId, definition, configuration, canOpen]);
  const { watchActions, readFile } = host;
  useEffect(() => {
    if (!check) return;
    return watchActions([check], ([result]) =>
      setPermission({
        input: check,
        allowed: result?.result?.allowed === true && !result.error,
      }),
    );
  }, [check, watchActions]);

  const { operations, operationSummaries } = host.state;
  const actorId = host.connection?.attachment.actorId;
  const latest = [...operations, ...operationSummaries].reduce<
    OperationSummary | undefined
  >((current, item) => {
    if (
      item.actionId !== builtinConnectionSequenceAction ||
      item.actorId !== actorId ||
      item.target.hostId !== hostId ||
      item.target.id !== deviceId
    )
      return current;
    return !current || item.acceptedAt > current.acceptedAt ? item : current;
  }, undefined);
  const operationId = acceptedId ?? revealedOperationId ?? latest?.operationId;
  const detail = operations.find(
    (item) =>
      item.operationId === operationId &&
      item.actionId === builtinConnectionSequenceAction,
  );
  const summary = operationSummaries.find(
    (item) =>
      item.operationId === operationId &&
      item.actionId === builtinConnectionSequenceAction,
  );
  const current =
    detail && (!summary || BigInt(detail.revision) >= BigInt(summary.revision))
      ? detail
      : summary;
  const busy = start.busy || running(current?.state);
  const completed =
    detail && current === detail && detail.state === "succeeded"
      ? detail
      : undefined;
  useEffect(() => {
    if (!completed) return;
    const controller = new AbortController();
    const { signal } = controller;
    void readConnectionSequenceResult(completed, readFile, signal).then(
      (result) => {
        if (!signal.aborted)
          setReport({ operationId: completed.operationId, result });
      },
      (error: unknown) => {
        if (!signal.aborted)
          setReport({
            operationId: completed.operationId,
            error: nativeErrorText(error, t),
          });
      },
    );
    return () => controller.abort();
  }, [completed, readFile, t]);
  const shown =
    completed && report?.operationId === completed.operationId
      ? report
      : undefined;

  useUnsavedWork({
    id,
    label: t("connectionSequence.title"),
    dirty: draft !== confirmedDraft,
    retainAfterUnmount: false,
    discard: () => setDraft(confirmedDraft),
  });
  function replaceStep(next: StepDraft) {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.key === next.key ? next : step)),
    }));
  }
  function moveStep(from: number, to: number) {
    setDraft((current) => {
      const steps = [...current.steps];
      const [moving] = steps.splice(from, 1);
      if (!moving) return current;
      steps.splice(to, 0, moving);
      return { ...current, steps };
    });
  }

  return (
    <div className="grid min-w-0 gap-4 py-2 @container/connection-sequence">
      <div className="grid items-start gap-4 @min-[42rem]/connection-sequence:grid-cols-[15rem_minmax(0,1fr)]">
        <section
          className="grid gap-3"
          aria-label={t("connectionSequence.device")}
        >
          <div className="grid gap-1">
            <strong className="text-sm">
              {device?.systemName ?? t("connectionSequence.chooseDevice")}
            </strong>
            <code className="text-sm text-muted-foreground">
              {formatSerialLine(configuration)}
            </code>
          </div>
          <label className="grid gap-1.5 text-sm">
            {t("connectionSequence.beforeOpen")}
            <Input
              value={draft.beforeOpenMs}
              inputMode="numeric"
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, beforeOpenMs: event.target.value })
              }
            />
          </label>
        </section>
        <section
          className="grid min-w-0 gap-2"
          aria-label={t("connectionSequence.afterOpen")}
        >
          <h3 className="text-sm font-medium">
            {t("connectionSequence.afterOpen")}
          </h3>
          <ol className="grid min-w-0 gap-2">
            {draft.steps.map((step, index) => (
              <li
                key={step.key}
                className="grid min-w-0 gap-2 rounded border p-2"
              >
                <div className="flex min-w-0 flex-wrap items-end gap-1">
                  <div className="mr-auto min-w-32 flex-1">
                    <label
                      htmlFor={`${id}-${step.key}-kind`}
                      className="mb-1 block text-sm"
                    >
                      {t("connectionSequence.step", { number: index + 1 })}
                    </label>
                    <OptionsSelect
                      id={`${id}-${step.key}-kind`}
                      value={step.kind}
                      options={kinds.map((value) => ({
                        value,
                        label: t(`connectionSequence.kind.${value}`),
                      }))}
                      disabled={busy}
                      onValueChange={(kind) =>
                        replaceStep(newStep(step.key, kind))
                      }
                    />
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    type="button"
                    aria-label={t("connectionSequence.moveUp")}
                    disabled={busy || index === 0}
                    onClick={() => moveStep(index, index - 1)}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    type="button"
                    aria-label={t("connectionSequence.moveDown")}
                    disabled={busy || index === draft.steps.length - 1}
                    onClick={() => moveStep(index, index + 1)}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    type="button"
                    aria-label={t("connectionSequence.remove")}
                    disabled={busy}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        steps: draft.steps.filter(
                          (item) => item.key !== step.key,
                        ),
                      })
                    }
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                <div className="grid min-w-0 gap-2 @min-[34rem]/connection-sequence:grid-cols-2">
                  {step.kind === "line" && (
                    <>
                      <div>
                        <label
                          htmlFor={`${id}-${step.key}-line`}
                          className="mb-1 block text-sm"
                        >
                          {t("connectionSequence.line")}
                        </label>
                        <OptionsSelect
                          id={`${id}-${step.key}-line`}
                          value={step.line}
                          options={[
                            { value: "dtr", label: "DTR" },
                            { value: "rts", label: "RTS" },
                          ]}
                          disabled={busy}
                          onValueChange={(line) =>
                            replaceStep({ ...step, line })
                          }
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={`${id}-${step.key}-level`}
                          className="mb-1 block text-sm"
                        >
                          {t("connectionSequence.level")}
                        </label>
                        <OptionsSelect
                          id={`${id}-${step.key}-level`}
                          value={step.value ? "high" : "low"}
                          options={[
                            {
                              value: "low",
                              label: t("connectionSequence.low"),
                            },
                            {
                              value: "high",
                              label: t("connectionSequence.high"),
                            },
                          ]}
                          disabled={busy}
                          onValueChange={(level) =>
                            replaceStep({ ...step, value: level === "high" })
                          }
                        />
                      </div>
                    </>
                  )}
                  {step.kind === "delay" && (
                    <label className="grid gap-1.5 text-sm">
                      {t("connectionSequence.delay")}
                      <Input
                        value={step.milliseconds}
                        inputMode="numeric"
                        disabled={busy}
                        onChange={(event) =>
                          replaceStep({
                            ...step,
                            milliseconds: event.target.value,
                          })
                        }
                      />
                    </label>
                  )}
                  {(step.kind === "send" || step.kind === "ready") && (
                    <label className="grid min-w-0 gap-1.5 text-sm">
                      {t("connectionSequence.hex")}
                      <Input
                        className="font-mono"
                        value={step.hex}
                        disabled={busy}
                        onChange={(event) =>
                          replaceStep({ ...step, hex: event.target.value })
                        }
                      />
                      {(() => {
                        const candidate = definition?.steps[index];
                        return candidate?.kind === "send" ||
                          candidate?.kind === "ready" ? (
                          <code className="break-all text-muted-foreground">
                            {formatHex(
                              Uint8Array.from(
                                atob(candidate.bytesBase64),
                                (byte) => byte.charCodeAt(0),
                              ),
                            )}
                          </code>
                        ) : null;
                      })()}
                    </label>
                  )}
                  {step.kind === "ready" && (
                    <label className="grid gap-1.5 text-sm">
                      {t("connectionSequence.timeout")}
                      <Input
                        value={step.timeoutMs}
                        inputMode="numeric"
                        disabled={busy}
                        onChange={(event) =>
                          replaceStep({
                            ...step,
                            timeoutMs: event.target.value,
                          })
                        }
                      />
                    </label>
                  )}
                </div>
                {input.row === index && (
                  <p className="text-sm text-destructive">
                    {t("connectionSequence.invalidStep")}
                  </p>
                )}
              </li>
            ))}
          </ol>
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={
              busy || draft.steps.length >= connectionSequenceMaximumSteps
            }
            onClick={() =>
              setDraft({
                ...draft,
                steps: [...draft.steps, newStep(++key.current, "line")],
              })
            }
          >
            {t("connectionSequence.add")}
          </Button>
        </section>
      </div>
      {device && !canOpen && !busy && current?.state !== "succeeded" && (
        <p className="text-sm text-muted-foreground">
          {t("connectionSequence.closedDevice")}
        </p>
      )}
      {!definition && input.row === undefined && draft !== emptyDraft && (
        <p className="text-sm text-destructive">
          {t("connectionSequence.invalidPlan")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            !check || busy || permission?.input !== check || !permission.allowed
          }
          onClick={() => {
            if (!check) return;
            void start.run(async (signal) => {
              const operation = await host.invoke(
                { ...check, executionMode: "independent" },
                signal,
              );
              signal.throwIfAborted();
              if (
                operation.actionId !== check.actionId ||
                operation.executionMode !== "independent" ||
                operation.target.kind !== "device" ||
                operation.target.hostId !== check.target.hostId ||
                operation.target.id !== check.target.id
              )
                throw new ContractValidationError();
              setAcceptedId(operation.operationId);
              setConfirmedDraft(draft);
              await host.waitForOperation(operation, signal);
            });
          }}
        >
          {t("connectionSequence.run")}
        </Button>
        {current && running(current.state) && (
          <Button
            size="sm"
            variant="outline"
            disabled={cancel.busy || current.state === "cancel_requested"}
            onClick={() =>
              void cancel.run((signal) =>
                requestOperationCancel(host, current, signal),
              )
            }
          >
            {t("workbench.cancel")}
          </Button>
        )}
      </div>
      {current && (
        <p role="status" className="text-sm">
          {operationText(t, () => "").states[current.state]}
          {current.progress &&
            ` · ${current.progress.completed} / ${current.progress.total ?? "?"}`}
        </p>
      )}
      {shown?.result && (
        <section
          className="grid gap-2 text-sm"
          aria-label={t("connectionSequence.result")}
        >
          <p>{t(`connectionSequence.outcome.${shown.result.outcome}`)}</p>
          <ol className="grid gap-1">
            {shown.result.steps.map((step, index) => (
              <li key={index}>
                {t(`connectionSequence.kind.${step.kind}`)} ·{" "}
                {t(`connectionSequence.state.${step.state}`)}
                {step.source &&
                  ` · RX [${step.source.byteStart}, ${step.source.byteEnd})`}
              </li>
            ))}
          </ol>
          {shown.result.session && inspectSession && (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => {
                const session = shown.result?.session;
                if (session) inspectSession(session);
              }}
            >
              {t("connectionSequence.inspect")}
            </Button>
          )}
        </section>
      )}
      {(cancel.error ?? start.error ?? shown?.error) && (
        <p role="alert" className="text-sm text-destructive">
          {cancel.error ?? start.error ?? shown?.error}
        </p>
      )}
    </div>
  );
}
