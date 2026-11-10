import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  BreakParams,
  ConfigureParams,
  ControlParams,
  DrainParams,
  Operation,
  PurgeParams,
  SessionSnapshot,
  Target,
  WaitBoundaryParams,
} from "@serial-workbench/contracts";
import type {
  HostActionAvailability,
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionsSelect } from "@/components/options-select";
import { nativeErrorCode } from "@/lib/native-error";
import { operationFailureEventKey, WorkbenchNotice } from "./workbench-notice";
import { SessionControlReceipts } from "./session-control-receipts";
import type { OperationText } from "./operation-text";
import { SessionInputSamples } from "./session-inputs";
import { SerialConfigurationFields } from "./serial-configuration-fields";
import {
  CONFIG_FIELDS,
  validDuration,
  validSerialConfiguration,
} from "./serial-configuration";

export type SessionControlsLabels = Record<
  | "sessionControls"
  | "configuration"
  | "baudRate"
  | "baudPresets"
  | "dataBits"
  | "parity"
  | "stopBits"
  | "flowControl"
  | "readWaitMs"
  | "writeWaitMs"
  | "reconnectBackoffMs"
  | "applyConfiguration"
  | "resetConfiguration"
  | "invalidConfiguration"
  | "controlLines"
  | "dtrOn"
  | "dtrOff"
  | "rtsOn"
  | "rtsOff"
  | "flowOwnsLine"
  | "breakDuration"
  | "finiteBreak"
  | "purgeDirection"
  | "purgeScope"
  | "purge"
  | "drain"
  | "throughOperation"
  | "queueWaitMs"
  | "waitBoundary"
  | "inputSignals"
  | "sampledAt"
  | "on"
  | "off"
  | "inputSignalsUnavailable"
  | "waitOutcome"
  | "requested"
  | "actual"
  | "unknown"
  | "applied"
  | "rejected"
  | "partial"
  | "confirmed"
  | "details"
  | "field"
  | "status"
  | "readback"
  | "configurationReceipt"
  | "controlReceipt"
  | "breakReceipt"
  | "receipt"
  | "unavailable"
  | "readOnly"
  | "gate"
  | "rx"
  | "tx"
  | "both"
  | "application"
  | "driver"
  | "none"
  | "even"
  | "odd"
  | "mark"
  | "space"
  | "one"
  | "onePointFive"
  | "two"
  | "rtsCts"
  | "xonXoff"
  | "dsrDtr",
  string
> & {
  operationText: OperationText;
  gates: Record<SessionSnapshot["txGate"], string>;
  failure(code: string | undefined): string;
};
export type SessionControlsProps = {
  onConfigurationApplied?: (
    configuration: SessionSnapshot["configuration"],
  ) => void;
  contextKey?: string;
  readInputs?: HostContextValue["sessionInputs"];
  session: SessionSnapshot | null;
  target?: Target;
  operations: readonly Operation[];
  disabled?: boolean;
  labels: SessionControlsLabels;
  invoke: HostContextValue["invoke"];
  waitForOperation: HostContextValue["waitForOperation"];
  watchActions: HostContextValue["watchActions"];
};
type ControlAction =
  | { actionId: "session.configure"; params: ConfigureParams }
  | { actionId: "session.control"; params: ControlParams }
  | { actionId: "session.break"; params: BreakParams }
  | { actionId: "session.purge"; params: PurgeParams }
  | { actionId: "tx.drain"; params: DrainParams }
  | { actionId: "tx.waitBoundary"; params: WaitBoundaryParams };

export function SessionControls(props: SessionControlsProps) {
  return props.session ? (
    <ControlsForm
      key={`${props.contextKey}:${props.target?.hostId}:${props.session.sessionId}:${props.session.sessionEpoch}`}
      {...props}
      session={props.session}
    />
  ) : null;
}

function ControlsForm({
  readInputs,
  session,
  target,
  operations,
  disabled = false,
  labels,
  invoke,
  waitForOperation,
  watchActions,
  onConfigurationApplied,
}: SessionControlsProps & { session: SessionSnapshot }) {
  const id = useId();
  const [draft, setDraft] = useState(session.configuration);
  const [submitted, setSubmitted] = useState(session.configuration);
  const [breakDuration, setBreakDuration] = useState("100");
  const [writeWait, setWriteWait] = useState(session.configuration.writeWaitMs);
  const [queueWait, setQueueWait] = useState("1000");
  const [throughOperation, setThroughOperation] = useState("");
  const [direction, setDirection] = useState<PurgeParams["direction"]>("both");
  const [scope, setScope] = useState<PurgeParams["scope"]>("both");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    code: string;
    eventKey?: string;
    occurrence: number;
  }>();
  const failureIndex = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);
  const blocked =
    disabled ||
    session.readOnly ||
    session.state !== "open" ||
    !target ||
    session.txGate !== "ready" ||
    session.controlState === "unknown";
  const invalid = !validSerialConfiguration(draft);
  const dirty = CONFIG_FIELDS.some(
    (field) => draft[field] !== submitted[field],
  );
  const hostId = target?.hostId;
  const actionTarget = useMemo<Target | undefined>(
    () =>
      hostId === undefined
        ? undefined
        : {
            hostId,
            kind: "session",
            id: session.sessionId,
            sessionId: session.sessionId,
            sessionEpoch: session.sessionEpoch,
          },
    [hostId, session.sessionId, session.sessionEpoch],
  );
  const inputs = useMemo<readonly HostActionCheckInput[]>(() => {
    if (!actionTarget) return [];
    const actions: ControlAction[] = [];
    if (!invalid)
      actions.push({
        actionId: "session.configure",
        params: { requested: draft },
      });
    for (const line of ["dtr", "rts"] as const)
      for (const value of [true, false])
        actions.push({ actionId: "session.control", params: { line, value } });
    if (validDuration(breakDuration))
      actions.push({
        actionId: "session.break",
        params: { durationMs: breakDuration },
      });
    actions.push({ actionId: "session.purge", params: { direction, scope } });
    if (validDuration(writeWait))
      actions.push({
        actionId: "tx.drain",
        params: { writeWaitMs: writeWait },
      });
    if (throughOperation.trim() && validDuration(queueWait))
      actions.push({
        actionId: "tx.waitBoundary",
        params: {
          throughOperationId: throughOperation,
          queueWaitMs: queueWait,
        },
      });
    return actions.map((action) => ({ ...action, target: actionTarget }));
  }, [
    actionTarget,
    invalid,
    draft,
    breakDuration,
    direction,
    scope,
    writeWait,
    throughOperation,
    queueWait,
  ]);
  const [availability, setAvailability] = useState<{
    inputs: readonly HostActionCheckInput[];
    watchActions: HostContextValue["watchActions"];
    values: readonly HostActionAvailability[];
  }>();
  useEffect(() => {
    if (inputs.length === 0) return;
    let active = true;
    const stop = watchActions(inputs, (values) => {
      if (active) setAvailability({ inputs, watchActions, values });
    });
    return () => {
      active = false;
      stop();
    };
  }, [inputs, watchActions]);
  function canAct(action: ControlAction) {
    if (
      blocked ||
      busy ||
      !actionTarget ||
      availability?.inputs !== inputs ||
      availability.watchActions !== watchActions
    )
      return false;
    switch (action.actionId) {
      case "session.configure":
        if (invalid || !session.capabilities.configuration) return false;
        break;
      case "session.control":
        if (
          !session.capabilities[action.params.line] ||
          (action.params.line === "rts" &&
            session.configuration.flowControl === "rtsCts") ||
          (action.params.line === "dtr" &&
            session.configuration.flowControl === "dsrDtr")
        )
          return false;
        break;
      case "session.break":
        if (
          !session.capabilities.finiteBreak ||
          !validDuration(action.params.durationMs)
        )
          return false;
        break;
      case "session.purge":
        if (
          (action.params.direction !== "tx" && !session.capabilities.purgeRx) ||
          (action.params.direction !== "rx" && !session.capabilities.purgeTx)
        )
          return false;
        break;
      case "tx.drain":
        if (
          !session.capabilities.drain ||
          !validDuration(action.params.writeWaitMs)
        )
          return false;
        break;
      case "tx.waitBoundary":
        if (
          !action.params.throughOperationId.trim() ||
          !validDuration(action.params.queueWaitMs)
        )
          return false;
        break;
    }
    const key = JSON.stringify({ ...action, target: actionTarget });
    return availability.values.some(
      (value) =>
        JSON.stringify(value.input) === key &&
        value.result?.allowed === true &&
        !value.error,
    );
  }
  async function act(action: ControlAction, signal?: AbortSignal) {
    if (!mounted.current || pending.current || !canAct(action) || !actionTarget)
      throw { code: "ACTION_UNAVAILABLE" };
    const controller = new AbortController();
    pending.current = controller;
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    setBusy(true);
    setError(undefined);
    try {
      const operation = await invoke(
        {
          ...action,
          target: actionTarget,
          expectedRevision: session.revision,
          executionMode: "interactive",
        },
        combined,
      );
      combined.throwIfAborted();
      if (operation.error)
        throw {
          code: operation.error.code,
          operationId: operation.operationId,
          executionHostId: operation.executionHostId,
        };
      if (action.actionId === "session.configure") {
        const terminal = await waitForOperation(operation, combined);
        combined.throwIfAborted();
        if (
          !mounted.current ||
          terminal.operationId !== operation.operationId ||
          terminal.actionId !== action.actionId ||
          terminal.executionHostId !== actionTarget.hostId ||
          terminal.target.hostId !== actionTarget.hostId ||
          terminal.target.kind !== actionTarget.kind ||
          terminal.target.id !== actionTarget.id ||
          terminal.target.sessionId !== actionTarget.sessionId ||
          terminal.target.sessionEpoch !== actionTarget.sessionEpoch ||
          terminal.state !== "succeeded" ||
          terminal.error ||
          terminal.result?.kind !== "configuration" ||
          CONFIG_FIELDS.some(
            (field) =>
              terminal.result?.kind !== "configuration" ||
              terminal.result.value.requested[field] !==
                action.params.requested[field],
          )
        )
          throw {
            code: terminal.error?.code ?? "INVALID_OPERATION_RESULT",
          };
        const receipt = terminal.result.value;
        if (
          CONFIG_FIELDS.every((field) =>
            receipt.fields.some(
              (value) =>
                value.field === field &&
                value.status === "applied" &&
                value.actual === action.params.requested[field],
            ),
          )
        ) {
          onConfigurationApplied?.({ ...action.params.requested });
        }
        setSubmitted((previous) => {
          const confirmed = { ...previous };
          for (const field of CONFIG_FIELDS) {
            const result = receipt.fields.find(
              (value) => value.field === field,
            );
            if (
              result?.status === "applied" &&
              result.actual === action.params.requested[field]
            )
              Object.assign(confirmed, {
                [field]: action.params.requested[field],
              });
          }
          return confirmed;
        });
        return terminal;
      }
      return operation;
    } finally {
      if (pending.current === controller) pending.current = null;
      if (mounted.current && !controller.signal.aborted) setBusy(false);
    }
  }
  async function apply(signal?: AbortSignal) {
    if (invalid || !session.capabilities.configuration)
      throw { code: "INVALID_ARGUMENT" };
    const snapshot = { ...draft };
    await act(
      { actionId: "session.configure", params: { requested: snapshot } },
      signal,
    );
  }
  function run(action: () => Promise<unknown>) {
    void action().catch((reason: unknown) => {
      if (
        mounted.current &&
        !(reason instanceof Error && reason.name === "AbortError")
      )
        setError({
          code: nativeErrorCode(reason) ?? "INTERNAL",
          occurrence: ++failureIndex.current,
          eventKey: operationFailureEventKey(reason),
        });
    });
  }
  useUnsavedWork({
    id: `session-configuration-${session.sessionId}-${session.sessionEpoch}`,
    label: labels.configuration,
    dirty,
    discard: () => setDraft(submitted),
  });
  const receipts = operations
    .filter(
      (operation) =>
        operation.target.hostId === actionTarget?.hostId &&
        operation.target.kind === "session" &&
        operation.target.id === session.sessionId &&
        operation.target.sessionId === session.sessionId &&
        operation.target.sessionEpoch === session.sessionEpoch &&
        [
          "session.configure",
          "session.control",
          "session.break",
          "session.purge",
          "tx.drain",
          "tx.waitBoundary",
        ].includes(operation.actionId),
    )
    .slice(0, 12);
  // 历史回执继续可读；只有本次用户请求的失败属于当前故障。
  const fault = error;
  return (
    <section
      aria-label={labels.sessionControls}
      data-panel-id="session-controls"
      className="workbench-tool-form"
      aria-busy={busy}
    >
      <h2 className="sr-only">{labels.sessionControls}</h2>
      <WorkbenchNotice
        noticeKey={`session-controls:${fault?.occurrence ?? "none"}`}
        eventKey={fault?.eventKey}
        log={
          fault
            ? {
                module: "serial",
                level: "error",
                code: fault.code,
                message: labels.failure(fault.code),
              }
            : undefined
        }
      >
        {fault ? <span role="alert">{labels.failure(fault.code)}</span> : null}
      </WorkbenchNotice>
      <div className="workbench-tool-page flex-1 space-y-4">
        {session.readOnly && <p role="status">{labels.readOnly}</p>}
        {session.txGate !== "ready" && (
          <p role="status">{labels.gates[session.txGate]}</p>
        )}
        <fieldset disabled={disabled || session.readOnly}>
          <legend>{labels.configuration}</legend>
          <SerialConfigurationFields
            id={id}
            value={draft}
            onChange={setDraft}
            labels={labels}
            disabled={disabled || session.readOnly}
          />
          <p
            className="workbench-configuration-validation"
            role={invalid ? "alert" : undefined}
          >
            {invalid ? labels.invalidConfiguration : ""}
          </p>
        </fieldset>
        <fieldset disabled={disabled || session.readOnly || busy}>
          <legend>{labels.controlLines}</legend>
          <div className="flex flex-wrap gap-2">
            {(["dtr", "rts"] as const).map((line) =>
              ([true, false] as const).map((value) => (
                <Button
                  key={`${line}-${value}`}
                  size="sm"
                  variant="outline"
                  disabled={
                    !canAct({
                      actionId: "session.control",
                      params: { line, value },
                    })
                  }
                  onClick={() =>
                    run(() =>
                      act({
                        actionId: "session.control",
                        params: { line, value },
                      }),
                    )
                  }
                >
                  {
                    labels[
                      line === "dtr"
                        ? value
                          ? "dtrOn"
                          : "dtrOff"
                        : value
                          ? "rtsOn"
                          : "rtsOff"
                    ]
                  }
                </Button>
              )),
            )}
          </div>
          {(session.configuration.flowControl === "rtsCts" ||
            session.configuration.flowControl === "dsrDtr") && (
            <p className="text-xs text-muted-foreground">
              {labels.flowOwnsLine}
            </p>
          )}
          <div className="workbench-form-fields mt-2">
            <label>
              {labels.breakDuration}
              <Input
                inputMode="numeric"
                value={breakDuration}
                aria-invalid={!validDuration(breakDuration)}
                onChange={(event) => setBreakDuration(event.target.value)}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !canAct({
                  actionId: "session.break",
                  params: { durationMs: breakDuration },
                })
              }
              onClick={() =>
                run(() =>
                  act({
                    actionId: "session.break",
                    params: { durationMs: breakDuration },
                  }),
                )
              }
            >
              {labels.finiteBreak}
            </Button>
            <label>
              {labels.purgeDirection}
              <OptionsSelect<PurgeParams["direction"]>
                label={labels.purgeDirection}
                value={direction}
                onValueChange={setDirection}
                disabled={disabled || session.readOnly || busy}
                options={(["rx", "tx", "both"] as const).map((value) => ({
                  value,
                  label: labels[value],
                }))}
              />
            </label>
            <label>
              {labels.purgeScope}
              <OptionsSelect<PurgeParams["scope"]>
                label={labels.purgeScope}
                value={scope}
                onValueChange={setScope}
                disabled={disabled || session.readOnly || busy}
                options={(["application", "driver", "both"] as const).map(
                  (value) => ({
                    value,
                    label: labels[value],
                  }),
                )}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !canAct({
                  actionId: "session.purge",
                  params: { direction, scope },
                })
              }
              onClick={() =>
                run(() =>
                  act({
                    actionId: "session.purge",
                    params: { direction, scope },
                  }),
                )
              }
            >
              {labels.purge}
            </Button>
            <label>
              {labels.drain} · {labels.writeWaitMs}
              <Input
                inputMode="numeric"
                value={writeWait}
                aria-invalid={!validDuration(writeWait)}
                onChange={(event) => setWriteWait(event.target.value)}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !canAct({
                  actionId: "tx.drain",
                  params: { writeWaitMs: writeWait },
                })
              }
              onClick={() =>
                run(() =>
                  act({
                    actionId: "tx.drain",
                    params: { writeWaitMs: writeWait },
                  }),
                )
              }
            >
              {labels.drain}
            </Button>
            <label>
              {labels.throughOperation}
              <Input
                value={throughOperation}
                onChange={(event) => setThroughOperation(event.target.value)}
              />
            </label>
            <label>
              {labels.queueWaitMs}
              <Input
                inputMode="numeric"
                value={queueWait}
                aria-invalid={!validDuration(queueWait)}
                onChange={(event) => setQueueWait(event.target.value)}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !canAct({
                  actionId: "tx.waitBoundary",
                  params: {
                    throughOperationId: throughOperation,
                    queueWaitMs: queueWait,
                  },
                })
              }
              onClick={() =>
                run(() =>
                  act({
                    actionId: "tx.waitBoundary",
                    params: {
                      throughOperationId: throughOperation,
                      queueWaitMs: queueWait,
                    },
                  }),
                )
              }
            >
              {labels.waitBoundary}
            </Button>
          </div>
        </fieldset>
        <SessionInputSamples
          target={actionTarget}
          read={readInputs}
          connected={!disabled && session.state === "open"}
          labels={labels}
        />
        <SessionControlReceipts operations={receipts} labels={labels} />
      </div>
      <div className="workbench-tool-footer">
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty}
          onClick={() => setDraft(submitted)}
        >
          {labels.resetConfiguration}
        </Button>
        <Button
          size="sm"
          disabled={
            !dirty ||
            !canAct({
              actionId: "session.configure",
              params: { requested: draft },
            })
          }
          onClick={() => run(() => apply())}
        >
          {labels.applyConfiguration}
        </Button>
      </div>
    </section>
  );
}
