import { useEffect, useId, useRef, useState } from "react";
import {
  ContractValidationError,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isRecord } from "@/lib/settings-model";
import { nativeErrorText } from "@/lib/native-error";
import type {
  HostContextValue,
  HostInvocation,
} from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { calendarMaxRuns } from "../../../packages/plugin-sdk/examples/reference-automation/calendar-settings";
import {
  prepareCalendar,
  readCalendarResult,
  sameCalendar,
  type CalendarActionId,
  type CalendarDraft,
  type CalendarInput,
  type CalendarReport,
} from "./calendar-tool-model";
import { repeatPending, repeatSendFrameBytes } from "./repeat-send-model";

type Access = Pick<
  HostContextValue,
  "invoke" | "waitForOperation" | "readFile"
> & {
  target: Target;
  port: string;
  prepare: (
    params: CalendarInput,
    signal: AbortSignal,
  ) => Promise<HostInvocation>;
  cancel?: (operation: Operation, signal?: AbortSignal) => Promise<void>;
};
type ScheduledRequest = {
  controller: AbortController;
  submitted: boolean;
  stopRequested: boolean;
};
type Settlement = { id: string } & (
  | { report: CalendarReport }
  | { error: unknown; cancelled: boolean; terminal: boolean }
);

function iso(ms: number) {
  return new Date(ms).toISOString();
}

export function CalendarScheduleTool({
  access,
  actionId,
  operations,
  draftBytes,
  remembered,
  remember,
}: {
  access?: Access;
  actionId?: CalendarActionId;
  operations: readonly Operation[];
  draftBytes?: Uint8Array;
  remembered?: Operation;
  remember: (operation: Operation) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<CalendarDraft>(() => ({
    mode: "once",
    at: "",
    endAt: "",
    expression: "",
    timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    count: "1",
    hex: "",
  }));
  const workId = useId();
  const [saved, setSaved] = useState(draft);
  const [admitted, setAdmitted] = useState(remembered);
  const [phase, setPhase] = useState<
    "preparing" | "submitting" | "stopQueued"
  >();
  const [settlement, setSettlement] = useState<Settlement>();
  const [problem, setProblem] = useState<string>();
  const [stopId, setStopId] = useState<string>();
  const [retry, setRetry] = useState(0);
  const mounted = useRef(false);
  const request = useRef<ScheduledRequest | null>(null);
  const requestedStop = useRef<string | undefined>(undefined);
  const admittedId = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.controller.abort();
    };
  }, []);

  const target = access?.target;
  const task = target
    ? operations.reduce<Operation | undefined>((latest, next) => {
        if (!sameCalendar(next, target)) return latest;
        if (latest && repeatPending(latest) && !repeatPending(next))
          return latest;
        return next;
      }, undefined)
    : undefined;
  const watched = admitted ?? task;
  const id = watched?.operationId;
  const projected =
    target && watched
      ? (operations.find(
          (item) => item.operationId === id && sameCalendar(item, target),
        ) ?? watched)
      : undefined;
  const result = settlement?.id === id ? settlement : undefined;
  const waiting = !!watched && !result;
  const active =
    projected &&
    repeatPending(projected) &&
    (!result || ("terminal" in result && !result.terminal))
      ? projected
      : undefined;
  const busy = !!phase || waiting || !!active;
  const prepared = prepareCalendar(draft);
  const latest = useRef({ access, watched });
  latest.current = { access, watched };

  useEffect(() => {
    const { access: observer, watched: operation } = latest.current;
    if (!observer || !operation || !id) return;
    const controller = new AbortController();
    const { signal } = controller;
    async function observe(scope: Access, owned: Operation) {
      try {
        const finished = await scope.waitForOperation(
          owned,
          signal,
          "succeeded",
          1_000,
        );
        const report = await readCalendarResult(
          owned,
          finished,
          scope.target,
          scope.readFile,
          signal,
        );
        if (!signal.aborted) setSettlement({ id: owned.operationId, report });
      } catch (error) {
        if (!signal.aborted) {
          const terminal =
            isRecord(error) &&
            error.executionHostId === owned.executionHostId &&
            error.operationId === owned.operationId &&
            typeof error.operationState === "string";
          const cancelled = terminal && error.operationState === "cancelled";
          setSettlement({ id: owned.operationId, error, cancelled, terminal });
        }
      }
    }
    void observe(observer, operation);
    return () => controller.abort();
  }, [id, retry]);

  useUnsavedWork({
    id: workId,
    label: t("calendar.title"),
    dirty: JSON.stringify(draft) !== JSON.stringify(saved),
    retainAfterUnmount: false,
    discard: () => setDraft(saved),
  });

  function update<Key extends keyof CalendarDraft>(
    key: Key,
    value: CalendarDraft[Key],
  ) {
    setDraft((old) => ({ ...old, [key]: value }));
  }

  async function stopOperation(
    operation: Operation,
    cancel: NonNullable<Access["cancel"]>,
  ) {
    if (
      !repeatPending(operation) ||
      requestedStop.current === operation.operationId
    )
      return;
    requestedStop.current = operation.operationId;
    if (mounted.current) {
      setStopId(operation.operationId);
      setProblem(undefined);
    }
    try {
      await cancel(operation);
    } catch (error) {
      if (requestedStop.current !== operation.operationId) return;
      requestedStop.current = undefined;
      if (
        mounted.current &&
        (latest.current.watched?.operationId === operation.operationId ||
          admittedId.current === operation.operationId)
      ) {
        setStopId(undefined);
        setProblem(nativeErrorText(error, t));
      }
    }
  }

  async function start() {
    if (!access || !actionId || !prepared.params || busy || request.current)
      return;
    const current = {
      controller: new AbortController(),
      submitted: false,
      stopRequested: false,
    };
    request.current = current;
    const { signal } = current.controller;
    setProblem(undefined);
    requestedStop.current = undefined;
    setStopId(undefined);
    setPhase("preparing");
    admittedId.current = undefined;
    setAdmitted(undefined);
    try {
      const input = await access.prepare(prepared.params, signal);
      signal.throwIfAborted();
      current.submitted = true;
      setPhase("submitting");
      const operation = await access.invoke(input);
      if (
        operation.actionId !== actionId ||
        !sameCalendar(operation, access.target)
      )
        throw new ContractValidationError(
          "Calendar acceptance belongs to another session",
        );
      admittedId.current = operation.operationId;
      if (current.stopRequested && access.cancel)
        void stopOperation(operation, access.cancel);
      remember(operation);
      if (!signal.aborted) {
        setSaved(draft);
        setAdmitted(operation);
      }
    } catch (error) {
      if (!signal.aborted) setProblem(nativeErrorText(error, t));
    } finally {
      if (request.current === current) {
        request.current = null;
        if (!signal.aborted) setPhase(undefined);
      }
    }
  }

  function stop() {
    const current = request.current;
    if (current && !current.submitted) {
      current.controller.abort();
      request.current = null;
      setPhase(undefined);
      setProblem(t("calendar.stoppedBeforeDispatch"));
    } else if (current) {
      current.stopRequested = true;
      setPhase("stopQueued");
    } else if (active && access?.cancel) {
      void stopOperation(active, access.cancel);
    }
  }

  const statusRegion = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase === "preparing" || phase === "submitting")
      statusRegion.current?.scrollIntoView({ block: "nearest" });
  }, [phase]);

  const progress = active?.progress;
  const report = result && "report" in result ? result.report : undefined;
  const observationFailed = result && "error" in result && !result.cancelled;
  const canStop = access?.cancel && (phase || active);
  const reusableDraft =
    !!draftBytes?.length && draftBytes.length <= repeatSendFrameBytes;

  return (
    <section className="@container/calendar-form grid min-w-0 gap-3">
      <p className="wrap-anywhere font-medium">
        {access
          ? t("repeatSend.destination", {
              port: access.port,
              epoch: access.target.sessionEpoch ?? "",
            })
          : t("repeatSend.selectSession")}
      </p>
      {access && !actionId ? (
        <p className="text-sm">{t("calendar.unavailable")}</p>
      ) : null}
      <fieldset className="grid min-w-0 gap-3" disabled={busy}>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={t("calendar.mode")}
        >
          <Button
            type="button"
            size="sm"
            variant={draft.mode === "once" ? "secondary" : "outline"}
            aria-pressed={draft.mode === "once"}
            onClick={() => update("mode", "once")}
          >
            {t("calendar.once")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={draft.mode === "cron" ? "secondary" : "outline"}
            aria-pressed={draft.mode === "cron"}
            onClick={() => update("mode", "cron")}
          >
            {t("calendar.cron")}
          </Button>
        </div>
        {draft.mode === "cron" ? (
          <div className="grid min-w-0 gap-3 @min-[32rem]/calendar-form:grid-cols-2">
            <label className="grid min-w-0 content-start gap-1.5 text-sm">
              {t("calendar.expression")}
              <Input
                className="min-w-0 font-mono"
                value={draft.expression}
                placeholder="15 8 * * MON-FRI"
                spellCheck={false}
                maxLength={160}
                onChange={(event) =>
                  update("expression", event.currentTarget.value)
                }
              />
            </label>
            <label className="grid min-w-0 content-start gap-1.5 text-sm">
              {t("calendar.zone")}
              <Input
                className="min-w-0 font-mono"
                value={draft.timeZone}
                placeholder="Asia/Shanghai"
                spellCheck={false}
                maxLength={100}
                onChange={(event) =>
                  update("timeZone", event.currentTarget.value)
                }
              />
            </label>
            <label className="grid min-w-0 content-start gap-1.5 text-sm">
              {t("calendar.end")}
              <Input
                className="min-w-0 font-mono"
                value={draft.endAt}
                placeholder="2026-12-31T23:59:00+08:00"
                spellCheck={false}
                maxLength={35}
                onChange={(event) => update("endAt", event.currentTarget.value)}
              />
            </label>
            <label className="grid min-w-0 content-start gap-1.5 text-sm">
              {t("calendar.count")}
              <Input
                type="number"
                min={1}
                max={calendarMaxRuns}
                step={1}
                value={draft.count}
                onChange={(event) => update("count", event.currentTarget.value)}
              />
            </label>
          </div>
        ) : (
          <label className="grid min-w-0 content-start gap-1.5 text-sm">
            {t("calendar.at")}
            <Input
              className="min-w-0 font-mono"
              value={draft.at}
              placeholder="2026-12-31T08:30:00+08:00"
              spellCheck={false}
              maxLength={35}
              onChange={(event) => update("at", event.currentTarget.value)}
            />
          </label>
        )}
        <label className="grid min-w-0 content-start gap-1.5 text-sm">
          {t("repeatSend.sendHex")}
          <Input
            className="min-w-0 font-mono"
            value={draft.hex}
            spellCheck={false}
            autoComplete="off"
            maxLength={repeatSendFrameBytes * 4}
            onChange={(event) => update("hex", event.currentTarget.value)}
          />
        </label>
        {reusableDraft ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="justify-self-start"
            onClick={() => {
              if (draftBytes) update("hex", formatHex(draftBytes));
            }}
          >
            {t("repeatSend.useDraft")}
          </Button>
        ) : null}
      </fieldset>
      <p className="text-sm text-muted-foreground">{t("calendar.policy")}</p>
      {prepared.params ? (
        <p className="wrap-anywhere text-sm">
          {t(
            draft.mode === "cron"
              ? "calendar.previewEnd"
              : "calendar.previewAt",
            { at: prepared.previewAt, bytes: String(prepared.size) },
          )}
        </p>
      ) : prepared.problem === "schedule" ? (
        <p className="text-sm text-muted-foreground">
          {t("calendar.invalidSchedule")}
        </p>
      ) : draft.hex ? (
        <p className="text-sm text-muted-foreground">
          {t("repeatSend.invalidHex")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-start gap-2 [&>button]:h-auto [&>button]:min-h-8 [&>button]:max-w-full [&>button]:whitespace-normal">
        <Button
          type="button"
          size="sm"
          disabled={!access || !actionId || !prepared.params || busy}
          onClick={() => void start()}
        >
          {t("calendar.arm")}
        </Button>
        {canStop ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              phase === "stopQueued" ||
              active?.state === "cancel_requested" ||
              (!!active && stopId === active.operationId)
            }
            onClick={stop}
          >
            {t("calendar.stop")}
          </Button>
        ) : null}
        {observationFailed ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setSettlement(undefined);
              setRetry((value) => value + 1);
            }}
          >
            {t("calendar.checkAgain")}
          </Button>
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="text-sm wrap-anywhere text-destructive">
          {problem}
        </p>
      ) : null}
      {watched || phase ? (
        <div
          ref={statusRegion}
          role="status"
          data-surface="reading"
          className="grid min-w-0 gap-1 rounded-md border p-3 text-sm wrap-anywhere tabular-nums"
        >
          {phase ? <p>{t(`calendar.${phase}`)}</p> : null}
          {watched ? (
            <p>{t("repeatSend.task", { id: watched.operationId })}</p>
          ) : null}
          {waiting && !phase ? (
            <p>
              {t(
                active && (stopId === id || active.state === "cancel_requested")
                  ? "repeatSend.cancelling"
                  : active
                    ? progress?.unit === "slots"
                      ? "calendar.armed"
                      : "calendar.accepted"
                    : "calendar.reading",
              )}
            </p>
          ) : null}
          {progress?.total ? (
            <p>
              {t("calendar.progress", {
                completed: progress.completed,
                total: progress.total,
              })}
            </p>
          ) : null}
          {observationFailed ? <p>{nativeErrorText(result.error, t)}</p> : null}
          {result && "cancelled" in result && result.cancelled ? (
            <p>{t("repeatSend.cancelled")}</p>
          ) : null}
          {report ? <p>{t(`calendar.outcome.${report.outcome}`)}</p> : null}
        </div>
      ) : null}
      {report && (report.runs.length > 0 || report.skipped.length > 0) ? (
        <details className="grid gap-1 text-sm">
          <summary className="cursor-pointer rounded-sm py-1.5 font-medium">
            {t("calendar.receipts")}
          </summary>
          <ul
            tabIndex={0}
            className="grid max-h-52 min-w-0 gap-1 overflow-auto rounded-md border p-3 wrap-anywhere tabular-nums focus-visible:outline-2 focus-visible:outline-ring"
          >
            {report.runs.map((run) => (
              <li key={run.operationId}>
                {t("calendar.receipt", {
                  id: run.operationId,
                  planned: iso(run.scheduledMs),
                  observed: iso(run.observedMs),
                  outcome: t(`calendar.slot.${run.outcome}`),
                })}
              </li>
            ))}
            {report.skipped.map((range) => (
              <li key={`${range.firstMs}:${range.throughMs}`}>
                {t("calendar.skipped", {
                  from: iso(range.firstMs),
                  through: iso(range.throughMs),
                })}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
