import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ContractValidationError,
  type Operation,
} from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { nativeErrorText } from "@/lib/native-error";
import { isTauri, saveTextExport } from "@/lib/tauri";
import type {
  HostContextValue,
  HostInvocation,
} from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  inspectRuleDefinition,
  ruleDefinitionLimit,
  sameRule,
  type RuleActionId,
} from "./rule-trigger-model";

import {
  RuleTaskObservationsContext,
  type RuleObservation,
  type RuleTaskAccess,
} from "./rule-task-observations";

type Access = RuleTaskAccess &
  Pick<HostContextValue, "invoke"> & {
    port: string;
    prepare: (
      definition: string,
      signal: AbortSignal,
    ) => Promise<HostInvocation>;
    cancel?: (operation: Operation, signal: AbortSignal) => Promise<void>;
  };

type ArmRequest = {
  controller: AbortController;
  phase: "preparing" | "submitting";
  stopRequested: boolean;
};

const example = JSON.stringify(
  {
    version: 1,
    observationMs: 30_000,
    condition: { kind: "regex", pattern: "^ALARM$" },
    effect: { kind: "notify", message: "ALARM" },
  },
  null,
  2,
);

function pending(operation: Operation) {
  return ["queued", "running", "cancel_requested"].includes(operation.state);
}

export function RuleTriggerTool({
  access,
  actionId,
  operations,
}: {
  access?: Access;
  actionId?: RuleActionId;
  operations: readonly Operation[];
}) {
  const { t } = useI18n();
  const observations = useContext(RuleTaskObservationsContext);
  const id = useId();
  const [definition, setDefinition] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState<ArmRequest["phase"]>();
  const [stopQueued, setStopQueued] = useState(false);
  const admitted = useRef<string | undefined>(undefined);
  const [accepted, setAccepted] = useState<Operation>();
  const [result, setResult] = useState<RuleObservation>();
  const [notice, setNotice] = useState<string>();
  const [cancelling, setCancelling] = useState<string>();
  const [retry, setRetry] = useState(0);
  const request = useRef<ArmRequest | null>(null);
  const mounted = useRef(false);
  const stopRequest = useRef<{
    operationId: string;
    controller: AbortController;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.controller.abort();
    };
  }, []);

  const validated = useMemo(
    () => inspectRuleDefinition(definition),
    [definition],
  );
  const target = access?.target;
  const active = target
    ? operations.reduce<Operation | undefined>(
        (last, item) => (sameRule(item, target) && pending(item) ? item : last),
        undefined,
      )
    : undefined;
  const watched =
    accepted ?? active ?? (access && observations?.recent(access));
  const shown =
    watched && target
      ? (operations.find(
          (item) =>
            item.operationId === watched.operationId && sameRule(item, target),
        ) ?? watched)
      : undefined;
  const finished = result?.id === watched?.operationId ? result : undefined;
  const refreshing = watched !== undefined && !finished;
  const busy =
    starting !== undefined ||
    refreshing ||
    (shown ? pending(shown) && !finished?.terminal : false);
  const observedId = watched?.operationId;
  const latest = useRef({ access, watched });
  latest.current = { access, watched };

  useEffect(() => {
    const { access: observer, watched: operation } = latest.current;
    if (!observer || !operation || !observedId || !observations) return;
    let current = true;
    void observations.observe(observer, operation).then((outcome) => {
      if (current) setResult(outcome);
    });
    return () => {
      current = false;
    };
  }, [observedId, observations, retry]);

  useUnsavedWork({
    id,
    label: t("ruleTrigger.definition"),
    dirty: definition !== saved,
    retainAfterUnmount: false,
    discard: () => setDefinition(saved),
  });

  async function arm() {
    if (
      !access ||
      !actionId ||
      !observations ||
      !validated ||
      busy ||
      saving ||
      request.current
    )
      return;
    const current: ArmRequest = {
      controller: new AbortController(),
      phase: "preparing",
      stopRequested: false,
    };
    const { signal } = current.controller;
    request.current = current;
    admitted.current = undefined;
    stopRequest.current?.controller.abort();
    stopRequest.current = null;
    setStarting("preparing");
    setStopQueued(false);
    setNotice(undefined);
    setCancelling(undefined);
    try {
      const input = await access.prepare(definition, signal);
      signal.throwIfAborted();
      current.phase = "submitting";
      setStarting("submitting");
      const operation = await access.invoke(input);
      if (
        operation.actionId !== actionId ||
        !sameRule(operation, access.target)
      )
        throw new ContractValidationError(
          "Rule acceptance belongs to another session",
        );
      void observations.observe(access, operation);
      if (!signal.aborted) {
        admitted.current = operation.operationId;
        setAccepted(operation);
      }
      if (current.stopRequested && pending(operation) && access.cancel) {
        if (signal.aborted)
          await access.cancel(operation, new AbortController().signal);
        else void stopOperation(operation, access.cancel);
      }
    } catch (error) {
      if (!signal.aborted) setNotice(nativeErrorText(error, t));
    } finally {
      if (request.current === current) {
        request.current = null;
        if (!signal.aborted) {
          setStarting(undefined);
          setStopQueued(false);
        }
      }
    }
  }

  async function stopOperation(
    operation: Operation,
    cancel: NonNullable<Access["cancel"]>,
  ) {
    if (
      !pending(operation) ||
      stopRequest.current?.operationId === operation.operationId ||
      cancelling === operation.operationId
    )
      return;
    const controller = new AbortController();
    stopRequest.current?.controller.abort();
    const stopping = { operationId: operation.operationId, controller };
    stopRequest.current = stopping;
    const ownsStop = () =>
      mounted.current &&
      !controller.signal.aborted &&
      stopRequest.current === stopping &&
      (latest.current.watched?.operationId === stopping.operationId ||
        admitted.current === stopping.operationId);
    setCancelling(operation.operationId);
    setNotice(undefined);
    try {
      await cancel(operation, controller.signal);
      if (finished && "error" in finished && ownsStop()) {
        setResult(undefined);
        setRetry((value) => value + 1);
      }
    } catch (error) {
      if (ownsStop()) {
        setCancelling(undefined);
        setNotice(nativeErrorText(error, t));
      }
    } finally {
      if (stopRequest.current === stopping) stopRequest.current = null;
    }
  }

  function stop() {
    const current = request.current;
    if (current?.phase === "preparing") {
      current.controller.abort();
      request.current = null;
      setStarting(undefined);
      setNotice(t("ruleTrigger.preflightStopped"));
      return;
    }
    if (current?.phase === "submitting") {
      if (access?.cancel) {
        current.stopRequested = true;
        setStopQueued(true);
      }
      return;
    }
    if (access?.cancel && shown) void stopOperation(shown, access.cancel);
  }

  async function save() {
    if (!validated || saving || busy) return;
    setSaving(true);
    try {
      if (await saveTextExport("serial-rule.json", definition))
        setSaved(definition);
    } catch (error) {
      setNotice(nativeErrorText(error, t));
    } finally {
      setSaving(false);
    }
  }

  const statusRegion = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (starting === "preparing" || starting === "submitting")
      statusRegion.current?.scrollIntoView({ block: "nearest" });
  }, [starting]);

  const invalid = Boolean(definition.trim() && !validated);
  return (
    <section className="grid min-w-0 gap-3">
      <p className="text-sm font-medium wrap-anywhere">
        {access
          ? t("repeatSend.destination", {
              port: access.port,
              epoch: access.target.sessionEpoch ?? "",
            })
          : t("repeatSend.selectSession")}
      </p>
      {!actionId ? (
        <p className="text-sm">{t("ruleTrigger.unavailable")}</p>
      ) : null}
      <label className="grid gap-1 text-sm">
        {t("ruleTrigger.definition")}
        <Textarea
          className="min-h-40 min-w-0 font-mono"
          spellCheck={false}
          value={definition}
          maxLength={ruleDefinitionLimit}
          disabled={busy || saving}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? id + "-invalid" : undefined}
          onChange={(event) => setDefinition(event.currentTarget.value)}
        />
      </label>
      {invalid && (
        <p id={id + "-invalid"} className="text-sm text-destructive">
          {t("ruleTrigger.invalid")}
        </p>
      )}
      {validated ? (
        <p className="text-sm wrap-anywhere">
          {t("ruleTrigger.plan", {
            condition: t(
              validated.kind === "regex"
                ? "ruleTrigger.regex"
                : "ruleTrigger.field",
            ),
            effect: t(
              validated.effect === "notify"
                ? "ruleTrigger.notify"
                : validated.effect === "send"
                  ? "ruleTrigger.send"
                  : "ruleTrigger.action",
            ),
            ms: validated.observationMs,
          })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-start gap-2 [&>button]:h-auto [&>button]:min-h-8 [&>button]:max-w-full [&>button]:whitespace-normal">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setDefinition(example)}
          disabled={busy || saving || Boolean(definition.trim())}
        >
          {t("commandSequence.example")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void save()}
          disabled={!validated || busy || saving}
        >
          {t(isTauri() ? "commandSequence.save" : "commandSequence.download")}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void arm()}
          disabled={
            !access ||
            !actionId ||
            !observations ||
            !validated ||
            busy ||
            saving
          }
        >
          {t("ruleTrigger.arm")}
        </Button>
        {starting === "preparing" ||
        (access?.cancel &&
          (starting === "submitting" ||
            (shown && pending(shown) && !finished?.terminal))) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={stop}
            disabled={
              stopQueued ||
              (!starting &&
                (shown?.state === "cancel_requested" ||
                  (shown && cancelling === shown.operationId)))
            }
          >
            {t("ruleTrigger.stop")}
          </Button>
        ) : null}
        {finished && "error" in finished && !finished.terminal && watched ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setResult(undefined);
              setRetry((value) => value + 1);
            }}
          >
            {t("commandSequence.retryObservation")}
          </Button>
        ) : null}
      </div>
      <div
        ref={statusRegion}
        role="status"
        data-surface="reading"
        className="grid min-w-0 gap-1 rounded-md border p-3 text-sm wrap-anywhere empty:hidden"
      >
        {starting ? (
          <p>
            {t(
              starting === "preparing"
                ? "ruleTrigger.preparing"
                : stopQueued
                  ? "ruleTrigger.stopQueued"
                  : "ruleTrigger.submitting",
            )}
          </p>
        ) : null}
        {refreshing && !starting ? (
          <p>
            {t(
              cancelling === observedId || shown?.state === "cancel_requested"
                ? "repeatSend.cancelling"
                : shown?.progress?.unit === "matches"
                  ? "ruleTrigger.armed"
                  : "ruleTrigger.preparing",
            )}
          </p>
        ) : null}
        {watched ? (
          <p>{t("repeatSend.task", { id: watched.operationId })}</p>
        ) : null}
        {finished && "stopped" in finished ? (
          <p>{t("repeatSend.cancelled")}</p>
        ) : null}
        {finished && "error" in finished ? (
          <p>{nativeErrorText(finished.error, t)}</p>
        ) : null}
        {notice ? <p>{notice}</p> : null}
        {finished && "report" in finished ? (
          <>
            <p>{t(`ruleTrigger.outcome.${finished.report.outcome}`)}</p>
            {"message" in finished.report ? (
              <p>{finished.report.message}</p>
            ) : null}
            {"source" in finished.report ? (
              <p>
                {t("commandSequence.rxRange", {
                  start: finished.report.source.byteStart,
                  end: finished.report.source.byteEnd,
                })}
              </p>
            ) : null}
            {"operationId" in finished.report ? (
              <p>
                {t("ruleTrigger.effectId", { id: finished.report.operationId })}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
