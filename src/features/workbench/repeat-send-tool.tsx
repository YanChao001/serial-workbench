import { useEffect, useRef, useState } from "react";
import {
  ContractValidationError,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { nativeErrorCode, nativeErrorText } from "@/lib/native-error";
import type { HostContextValue } from "@/providers/host-context";
import { useI18n, type DictKey } from "@/providers/i18n";
import {
  initialRepeatSendDraft,
  prepareRepeatSend,
  readRepeatResult,
  repeatJitterLimit,
  repeatPending,
  repeatSendFrameBytes,
  repeatSendLimits,
  sameRepeatSend,
  type RepeatSendActionId,
  type RepeatSendDraft,
  type RepeatSendResult,
} from "./repeat-send-model";

type Run =
  | { phase: "idle" | "starting" }
  | { phase: "running"; admitted: Operation }
  | { phase: "finished"; id: string; result: RepeatSendResult }
  | { phase: "failed"; id?: string; code?: string; cancelled: boolean };

type Access = Pick<
  HostContextValue,
  "invoke" | "waitForOperation" | "readFile"
> & {
  target: Target;
  port: string;
  startEventSeq: string;
  cancel?: (operation: Operation, signal: AbortSignal) => Promise<void>;
};

type NumericSetting =
  | "periodMs"
  | "count"
  | "jitterMs"
  | "startDelayMs"
  | "startTimeoutMs"
  | "responseTimeoutMs";

function RepeatNumber({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  disabled: boolean;
}) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <Input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function RepeatHex({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <Input
        className="font-mono"
        spellCheck={false}
        autoComplete="off"
        maxLength={repeatSendFrameBytes * 4}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

export function RepeatSendTool({
  access,
  actionId,
  operations,
  draftBytes,
}: {
  access?: Access;
  actionId?: RepeatSendActionId;
  operations: readonly Operation[];
  draftBytes?: Uint8Array;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initialRepeatSendDraft);
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const [cancelId, setCancelId] = useState<string>();
  const [cancelError, setCancelError] = useState<string>();
  const request = useRef<AbortController | null>(null);
  const stopRequest = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      request.current?.abort();
      stopRequest.current?.abort();
    },
    [],
  );

  const target = access?.target;
  const active = target
    ? operations.reduce<Operation | undefined>(
        (last, op) =>
          sameRepeatSend(op, target) && repeatPending(op) ? op : last,
        undefined,
      )
    : undefined;
  const tracked =
    run.phase === "running"
      ? (operations.find(
          (op) =>
            op.operationId === run.admitted.operationId &&
            sameRepeatSend(op, run.admitted.target),
        ) ?? run.admitted)
      : undefined;
  const current = tracked && repeatPending(tracked) ? tracked : active;
  const busy = run.phase === "starting" || run.phase === "running" || !!current;
  const prepared = prepareRepeatSend(draft, access?.startEventSeq ?? "1");
  const set = (field: keyof RepeatSendDraft, value: string) =>
    setDraft((previous) => ({ ...previous, [field]: value }));
  const ms = (
    field: NumericSetting,
    label: DictKey,
    limits: readonly [number, number],
  ) => (
    <RepeatNumber
      label={t(label)}
      value={draft[field]}
      onChange={(value) => set(field, value)}
      min={limits[0]}
      max={limits[1]}
      disabled={busy}
    />
  );

  function fail(error: unknown, id: string | undefined, signal: AbortSignal) {
    if (signal.aborted) return;
    setRun({
      phase: "failed",
      id,
      code: nativeErrorCode(error),
      cancelled:
        typeof error === "object" &&
        error !== null &&
        "operationState" in error &&
        error.operationState === "cancelled",
    });
  }

  async function settle(
    access: Access,
    operation: Operation,
    signal: AbortSignal,
  ) {
    const completed = await access.waitForOperation(operation, signal);
    const result = await readRepeatResult(
      operation,
      completed,
      access.target,
      access.readFile,
      signal,
    );
    if (!signal.aborted)
      setRun({ phase: "finished", id: operation.operationId, result });
  }

  async function start() {
    if (!access || !actionId || !prepared.params || busy || request.current)
      return;
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    setRun({ phase: "starting" });
    setCancelId(undefined);
    setCancelError(undefined);
    let id: string | undefined;
    try {
      const accepted = await access.invoke(
        {
          actionId,
          target: access.target,
          params: prepared.params,
          executionMode: "independent",
        },
        signal,
      );
      signal.throwIfAborted();
      if (
        accepted.actionId !== actionId ||
        !sameRepeatSend(accepted, access.target)
      )
        throw new ContractValidationError(
          "Repeat send belongs to another session",
        );
      id = accepted.operationId;
      setRun({ phase: "running", admitted: accepted });
      await settle(access, accepted, signal);
    } catch (error) {
      fail(error, id, signal);
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  async function cancel() {
    if (
      !access?.cancel ||
      !current ||
      stopRequest.current ||
      current.operationId === cancelId
    )
      return;
    const controller = new AbortController();
    stopRequest.current = controller;
    const id = current.operationId;
    setCancelId(id);
    setCancelError(undefined);
    try {
      await access.cancel(current, controller.signal);
      if (!controller.signal.aborted && run.phase !== "running") {
        setRun({ phase: "running", admitted: current });
        try {
          await settle(access, current, controller.signal);
        } catch (error) {
          fail(error, id, controller.signal);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setCancelId(undefined);
        setCancelError(nativeErrorCode(error) ?? "INTERNAL");
      }
    } finally {
      if (stopRequest.current === controller) stopRequest.current = null;
    }
  }

  const progress = current?.progress;
  const jitterLimit =
    Math.max(
      0,
      repeatJitterLimit(
        Math.min(Number(draft.periodMs), repeatSendLimits.periodMs[1]),
      ),
    ) || 0;
  return (
    <section className="grid gap-3">
      {access ? (
        <p className="wrap-anywhere font-medium">
          {t("repeatSend.destination", {
            port: access.port,
            epoch: access.target.sessionEpoch ?? "",
          })}
        </p>
      ) : (
        <p>{t("repeatSend.selectSession")}</p>
      )}
      {!actionId && (
        <p className="text-sm text-muted-foreground">
          {t("repeatSend.unavailable")}
        </p>
      )}
      <RepeatHex
        label={t("repeatSend.sendHex")}
        value={draft.send}
        disabled={busy}
        onChange={(value) => set("send", value)}
      />
      {draftBytes &&
        draftBytes.length > 0 &&
        draftBytes.length <= repeatSendFrameBytes && (
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => set("send", formatHex(draftBytes))}
            >
              {t("repeatSend.useDraft")}
            </Button>
          </div>
        )}
      <div className="workbench-form-grid workbench-form-grid-pair">
        {ms("periodMs", "repeatSend.period", repeatSendLimits.periodMs)}
        {ms("count", "repeatSend.count", repeatSendLimits.count)}
      </div>
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          {t("repeatSend.conditions")}
        </summary>
        <div className="mt-2 grid gap-3">
          <div className="workbench-form-grid workbench-form-grid-pair">
            {ms(
              "startDelayMs",
              "repeatSend.initialDelay",
              repeatSendLimits.startDelayMs,
            )}
            {ms("jitterMs", "repeatSend.jitter", [0, jitterLimit])}
          </div>
          <RepeatHex
            label={t("repeatSend.startHex")}
            value={draft.startOn}
            disabled={busy}
            onChange={(value) => set("startOn", value)}
          />
          {draft.startOn.trim() &&
            ms(
              "startTimeoutMs",
              "repeatSend.startTimeout",
              repeatSendLimits.startTimeoutMs,
            )}
          <RepeatHex
            label={t("repeatSend.stopHex")}
            value={draft.stopOn}
            disabled={busy}
            onChange={(value) => set("stopOn", value)}
          />
          <RepeatHex
            label={t("repeatSend.expectHex")}
            value={draft.expect}
            disabled={busy}
            onChange={(value) => set("expect", value)}
          />
          {draft.expect.trim() &&
            ms(
              "responseTimeoutMs",
              "repeatSend.replyTimeout",
              repeatSendLimits.responseTimeoutMs,
            )}
        </div>
      </details>
      {prepared.send && (
        <div className="rounded-md border px-3 py-2">
          <p className="text-sm">
            {t("repeatSend.preview", { count: prepared.send.length })}
          </p>
          <code className="break-all">{formatHex(prepared.send)}</code>
        </div>
      )}
      {prepared.problem && draft.send && (
        <p className="text-sm text-destructive">
          {t(
            prepared.problem === "hex"
              ? "repeatSend.invalidHex"
              : "repeatSend.invalidTiming",
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => void start()}
          size="sm"
          disabled={!access || !actionId || !prepared.params || busy}
        >
          {t("repeatSend.start")}
        </Button>
        {access?.cancel && current && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              current.operationId === cancelId ||
              current.state === "cancel_requested"
            }
            onClick={() => void cancel()}
          >
            {t("repeatSend.cancel")}
          </Button>
        )}
      </div>
      {cancelError && (
        <p role="alert">{nativeErrorText({ code: cancelError }, t)}</p>
      )}
      <div role="status" className="grid gap-1 text-sm">
        {run.phase === "starting" && <p>{t("repeatSend.submitting")}</p>}
        {current && (
          <>
            <p>
              {t(
                current.operationId === cancelId ||
                  current.state === "cancel_requested"
                  ? "repeatSend.cancelling"
                  : "repeatSend.running",
              )}
            </p>
            {progress?.total && (
              <p>
                {t("repeatSend.progress", {
                  completed: progress.completed,
                  total: progress.total,
                })}
              </p>
            )}
            <p className="wrap-anywhere text-muted-foreground">
              {t("repeatSend.task", { id: current.operationId })}
            </p>
          </>
        )}
        {run.phase === "failed" && (
          <>
            <p>
              {run.cancelled
                ? t("repeatSend.cancelled")
                : nativeErrorText({ code: run.code }, t)}
            </p>
            {run.id && (
              <p className="wrap-anywhere text-muted-foreground">
                {t("repeatSend.task", { id: run.id })}
              </p>
            )}
          </>
        )}
        {run.phase === "finished" && (
          <>
            <p>{t(`repeatSend.outcome.${run.result.outcome}`)}</p>
            <p>
              {t("repeatSend.resultSummary", {
                completed: run.result.completed,
                skipped: run.result.skippedSlots,
              })}
            </p>
            <p className="wrap-anywhere text-muted-foreground">
              {t("repeatSend.task", { id: run.id })}
            </p>
          </>
        )}
      </div>
      {run.phase === "finished" && run.result.attempted.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm">
            {t("repeatSend.receipts")}
          </summary>
          <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-sm">
            {run.result.attempted.map(
              ({ operationId, outcome, scheduledMs, startedMs }) => (
                <li key={operationId} className="break-all">
                  {t("repeatSend.receipt", {
                    scheduled: scheduledMs,
                    started: startedMs,
                  })}{" "}
                  {t(`repeatSend.outcome.${outcome}`)} · {operationId}
                </li>
              ),
            )}
          </ul>
        </details>
      )}
    </section>
  );
}
