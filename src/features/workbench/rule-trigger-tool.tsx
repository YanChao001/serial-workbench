import {
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ContractValidationError,
  type ActionSpec,
  type Operation,
} from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { nativeErrorText } from "@/lib/native-error";
import { rpcJsonObject } from "@/lib/rpc-json";
import { isTauri, saveTextExport } from "@/lib/tauri";
import type {
  HostContextValue,
  HostInvocation,
} from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { useSettings } from "@/providers/settings";
import { useUnsavedWork } from "@/providers/unsaved-work";
import {
  inspectRuleDefinition,
  ruleActionIds,
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
  Pick<HostContextValue, "invoke" | "checkAction"> & {
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

const responseExample = JSON.stringify(
  {
    version: 1,
    observationMs: 30_000,
    startAtBoundary: true,
    condition: { kind: "hex", hex: "50 49 4E 47" },
    effect: { kind: "send", bytesBase64: "UE9ORw==", responseDelayMs: 250 },
  },
  null,
  2,
);

const reservedRuleActions = new Set<string>([
  ...ruleActionIds,
  "session.tx",
  "lease.acquire",
  "lease.release",
]);

function pending(operation: Operation) {
  return ["queued", "running", "cancel_requested"].includes(operation.state);
}

const subscribeToNoAlerts = () => () => {};

export function RuleTriggerTool({
  access,
  actionId,
  operations,
  catalog,
}: {
  access?: Access;
  actionId?: RuleActionId;
  operations: readonly Operation[];
  catalog: readonly ActionSpec[];
}) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const observations = useContext(RuleTaskObservationsContext);
  const id = useId();
  const [definition, setDefinition] = useState("");
  const [backgroundAlert, setBackgroundAlert] = useState(false);
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
  const offerBackgroundAlert = isTauri() && validated?.effect === "notify";
  const enableBackgroundAlert =
    offerBackgroundAlert && settings.runInBackground;
  const effect = validated?.effect === "action" ? validated.action : undefined;
  const spec =
    effect && catalog.find((entry) => entry.actionId === effect.actionId);
  let definitionError: string | undefined;
  if (!validated && definition.trim())
    definitionError = t("ruleTrigger.invalid");
  if (effect && actionId) {
    if (reservedRuleActions.has(effect.actionId))
      definitionError = t("ruleTrigger.actionReserved", {
        action: effect.actionId,
      });
    else if (!spec)
      definitionError = t("ruleTrigger.actionUnavailable", {
        action: effect.actionId,
      });
    else if (
      spec.kind !== "action" ||
      spec.executionLocation !== "resource_host" ||
      !spec.targetKinds.includes("session")
    )
      definitionError = t("ruleTrigger.actionTarget", {
        action: effect.actionId,
      });
  }
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
  const alertStatus = useSyncExternalStore(
    observations?.subscribeBackgroundAlerts ?? subscribeToNoAlerts,
    () =>
      access && watched
        ? observations?.backgroundAlert(access, watched)
        : undefined,
  );
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
      definitionError ||
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
      if (effect) {
        const check = await access.checkAction(
          {
            actionId: effect.actionId,
            target: access.target,
            params: rpcJsonObject(effect.params),
          },
          signal,
        );
        signal.throwIfAborted();
        if (!check.allowed) {
          setNotice(t("ruleTrigger.actionDenied", { action: effect.actionId }));
          return;
        }
      }
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
      void observations.observe(
        access,
        operation,
        enableBackgroundAlert && backgroundAlert,
      );
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
          aria-invalid={Boolean(definitionError) || undefined}
          aria-describedby={definitionError ? id + "-invalid" : undefined}
          onChange={(event) => {
            setDefinition(event.currentTarget.value);
            setNotice(undefined);
          }}
        />
      </label>
      {definitionError && (
        <p
          id={id + "-invalid"}
          className="text-sm text-destructive wrap-anywhere"
        >
          {definitionError}
        </p>
      )}
      {validated ? (
        <p className="text-sm wrap-anywhere">
          {t("ruleTrigger.plan", {
            condition: t(`ruleTrigger.${validated.kind}`),
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
      {offerBackgroundAlert && (
        <div className="grid gap-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Switch
              id={id + "-background-alert"}
              aria-describedby={id + "-background-alert-hint"}
              checked={enableBackgroundAlert && backgroundAlert}
              disabled={!enableBackgroundAlert || busy || saving}
              onCheckedChange={setBackgroundAlert}
            />
            <label htmlFor={id + "-background-alert"}>
              {t("ruleTrigger.backgroundAlert")}
            </label>
          </div>
          <p
            id={id + "-background-alert-hint"}
            className="text-muted-foreground wrap-anywhere"
          >
            {t(
              enableBackgroundAlert
                ? "ruleTrigger.backgroundAlertHint"
                : "ruleTrigger.backgroundAlertEnable",
            )}
          </p>
        </div>
      )}
      {validated?.effect === "send" && (
        <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {validated.requestHex && (
            <>
              <dt>{t("ruleTrigger.requestHex")}</dt>
              <dd className="min-w-0 font-mono wrap-anywhere">
                {validated.requestHex}
              </dd>
            </>
          )}
          <dt>{t("ruleTrigger.responseHex")}</dt>
          <dd className="min-w-0 font-mono wrap-anywhere">
            {validated.responseHex}
          </dd>
          <dt>{t("ruleTrigger.responseDelay")}</dt>
          <dd className="tabular-nums">
            {t("ruleTrigger.delayValue", { ms: validated.responseDelayMs })}
          </dd>
        </dl>
      )}
      {validated?.kind === "hex" && (
        <p className="text-xs text-muted-foreground">
          {t("ruleTrigger.hexBoundary")}
        </p>
      )}
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
          onClick={() => setDefinition(responseExample)}
          disabled={busy || saving || Boolean(definition.trim())}
        >
          {t("ruleTrigger.responseExample")}
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
            Boolean(definitionError) ||
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
                  ? shown.progress.completed === "1"
                    ? "ruleTrigger.matched"
                    : "ruleTrigger.armed"
                  : "ruleTrigger.preparing",
            )}
          </p>
        ) : null}
        {alertStatus ? (
          <p>{t(`ruleTrigger.backgroundAlert.${alertStatus}`)}</p>
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
