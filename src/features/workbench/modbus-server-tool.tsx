import { useId, useState, type FormEvent } from "react";
import { formatHex, parseHex } from "@serial-workbench/host-client";
import {
  ContractValidationError,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { OptionsSelect } from "@/components/options-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/providers/i18n";
import { useUnsavedWork } from "@/providers/unsaved-work";
import type { HostContextValue } from "@/providers/host-context";
import { readVerifiedFile } from "@/lib/host-reader";
import { nativeErrorText } from "@/lib/native-error";
import { isRecord } from "@/lib/settings-model";
import { ProtocolFieldError } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import type { ModbusUnitRouting } from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-exchange";
import {
  encodeModbusFrame,
  modbusFrameLimits,
  type ModbusTransport,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame";
import {
  modbusServerLimits,
  parseModbusServerModel,
  simulateModbusServer,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-server";
import {
  modbusSlaveAction,
  parseModbusSlaveReport,
} from "./modbus-slave-model";
import { useToolAction } from "./transfer-capture-actions";

type Draft = {
  transport: ModbusTransport;
  routing: ModbusUnitRouting;
  definition: string;
  request: string;
};
type Model = ReturnType<typeof simulateModbusServer>["model"];
type Result = ReturnType<typeof simulateModbusServer>;
export type ModbusSlaveAccess = Pick<
  HostContextValue,
  "invoke" | "readFile" | "waitForOperation"
> & {
  target: Target;
  startEventSeq: string;
  available: boolean;
  cancel?: (operation: Operation, signal?: AbortSignal) => Promise<void>;
};
const initial: Draft = {
  transport: "rtu",
  routing: "gateway",
  definition: "",
  request: "",
};

function requestSample(input: string) {
  try {
    return parseHex(input);
  } catch {
    throw new ProtocolFieldError("request.hex", "Expected hexadecimal request");
  }
}

export default function ModbusServerTool({
  access,
}: {
  access?: ModbusSlaveAccess;
}) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [model, setModel] = useState<Model>();
  const [result, setResult] = useState<Result>();
  const [issue, setIssue] = useState<string>();
  const [duration, setDuration] = useState(15_000);
  const [requestLimit, setRequestLimit] = useState(16);
  const [replyDelay, setReplyDelay] = useState(0);
  const [running, setRunning] = useState<Operation>();
  const [stopRequested, setStopRequested] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [liveReport, setLiveReport] =
    useState<ReturnType<typeof parseModbusSlaveReport>>();
  const live = useToolAction((reason) => nativeErrorText(reason, t));
  const stop = useToolAction((reason) => nativeErrorText(reason, t));
  useUnsavedWork({
    id,
    label: t("workbench.modbusServer.title"),
    dirty: draft.definition !== "" || draft.request !== "",
    retainAfterUnmount: false,
    discard: () => {
      change(initial);
      setModel(undefined);
    },
  });

  function change(patch: Partial<Draft>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setIssue(undefined);
    setResult(undefined);
    setLiveReport(undefined);
    setCancelled(false);
    if (patch.definition !== undefined) setModel(undefined);
  }

  function example() {
    const unitId = 1;
    const definition = {
      unitId,
      tables: {
        coils: [{ start: 0, values: [true, false, true, false] }],
        discreteInputs: [{ start: 0, values: [false, true] }],
        holdingRegisters: [{ start: 0, values: [4660, 0, 22136] }],
        inputRegisters: [{ start: 100, values: [25, 50] }],
      },
    };
    const packet = {
      unitId,
      ...(draft.transport === "tcp" ? { transactionId: 1 } : {}),
      pdu: { functionCode: 6, address: 1, value: 258 },
    };
    change({
      definition: JSON.stringify(definition, null, 2),
      request: formatHex(encodeModbusFrame(draft.transport, "request", packet)),
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(undefined);
    setLiveReport(undefined);
    setCancelled(false);
    setIssue(undefined);
    try {
      const definition: unknown = model ?? JSON.parse(draft.definition);
      const next = simulateModbusServer(
        draft.transport,
        requestSample(draft.request),
        definition,
        draft.routing,
      );
      setModel(next.model);
      setResult(next);
    } catch (error) {
      if (error instanceof ProtocolFieldError) setIssue(error.path);
      else if (error instanceof SyntaxError) setIssue("model.json");
      else throw error;
    }
  }

  function startLive() {
    if (!access?.available || live.busy || stop.busy) return;
    setIssue(undefined);
    let initialModel: Model;
    try {
      const definition: unknown = model ?? JSON.parse(draft.definition);
      initialModel = parseModbusServerModel(definition);
    } catch (error) {
      if (error instanceof ProtocolFieldError) setIssue(error.path);
      else if (error instanceof SyntaxError) setIssue("model.json");
      else throw error;
      return;
    }
    setLiveReport(undefined);
    setResult(undefined);
    setStopRequested(false);
    setCancelled(false);
    const { target } = access;
    void live.run(async (signal) => {
      try {
        const accepted = await access.invoke(
          {
            actionId: modbusSlaveAction,
            target,
            params: {
              transport: draft.transport,
              ...(draft.transport === "tcp" && { unitRouting: draft.routing }),
              model: initialModel,
              startEventSeq: access.startEventSeq,
              durationMs: duration,
              requestLimit,
              replyDelayMs: replyDelay,
            },
            executionMode: "independent",
          },
          signal,
        );
        signal.throwIfAborted();
        setRunning(accepted);
        let completed: Operation;
        try {
          completed = await access.waitForOperation(accepted, signal);
        } catch (reason) {
          if (
            !isRecord(reason) ||
            reason.operationState !== "cancelled" ||
            reason.operationId !== accepted.operationId ||
            reason.executionHostId !== target.hostId
          )
            throw reason;
          signal.throwIfAborted();
          setCancelled(true);
          return;
        }
        const ref =
          completed.result?.kind === "reference"
            ? completed.result.value.resultRef
            : undefined;
        if (
          completed.actionId !== modbusSlaveAction ||
          completed.operationId !== accepted.operationId ||
          completed.target.hostId !== target.hostId ||
          completed.target.kind !== target.kind ||
          completed.target.id !== target.id ||
          completed.target.sessionId !== target.sessionId ||
          completed.target.sessionEpoch !== target.sessionEpoch ||
          ref?.hostId !== target.hostId ||
          ref.kind !== "plugin_result" ||
          ref.id !== completed.operationId
        )
          throw new ContractValidationError(
            "Modbus slave result belongs to another operation",
          );
        const bytes = await readVerifiedFile(ref, access.readFile, signal);
        const content: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        const report = parseModbusSlaveReport(content, target);
        signal.throwIfAborted();
        setModel(report.model);
        setLiveReport(report);
      } finally {
        if (!signal.aborted) setRunning(undefined);
      }
    });
  }

  function stopLive() {
    const cancel = access?.cancel;
    if (!running || !cancel || stopRequested || stop.busy) return;
    void stop.run(async (signal) => {
      await cancel(running, signal);
      signal.throwIfAborted();
      setStopRequested(true);
    });
  }

  const validTime =
    Number.isInteger(duration) && duration >= 100 && duration <= 120_000;
  const validLimit =
    Number.isInteger(requestLimit) && requestLimit >= 1 && requestLimit <= 64;
  const validDelay =
    Number.isInteger(replyDelay) && replyDelay >= 0 && replyDelay <= 2000;

  return (
    <details className="space-y-3 border-t pt-3">
      <summary className="cursor-pointer text-sm font-medium">
        {t("workbench.modbusServer.title")}
      </summary>
      <form className="space-y-3" onSubmit={submit}>
        <fieldset className="space-y-3" disabled={live.busy}>
          <div className="flex flex-wrap gap-3">
            <label className="grid gap-1.5 text-sm" htmlFor={id + "-transport"}>
              {t("workbench.modbus.transport")}
              <OptionsSelect<ModbusTransport>
                id={id + "-transport"}
                value={draft.transport}
                options={[
                  { value: "rtu", label: "RTU" },
                  { value: "ascii", label: "ASCII" },
                  { value: "tcp", label: "TCP" },
                ]}
                onValueChange={(transport) => change({ transport })}
              />
            </label>
            {draft.transport === "tcp" ? (
              <label className="grid gap-1.5 text-sm" htmlFor={id + "-routing"}>
                {t("workbench.modbus.routing")}
                <OptionsSelect<ModbusUnitRouting>
                  id={id + "-routing"}
                  value={draft.routing}
                  options={[
                    { value: "gateway", label: t("workbench.modbus.gateway") },
                    { value: "direct", label: t("workbench.modbus.direct") },
                  ]}
                  onValueChange={(routing) => change({ routing })}
                />
              </label>
            ) : null}
          </div>
          <label className="grid gap-1.5 text-sm" htmlFor={id + "-model"}>
            {t("workbench.modbusServer.model")}
            <Textarea
              id={id + "-model"}
              value={draft.definition}
              maxLength={modbusServerLimits.definition}
              className="min-h-24 font-mono text-xs"
              spellCheck={false}
              aria-invalid={issue?.startsWith("model") ?? false}
              aria-describedby={
                id + (issue?.startsWith("model") ? "-error" : "-help")
              }
              onChange={(event) =>
                change({ definition: event.currentTarget.value })
              }
            />
          </label>
          <label className="grid gap-1.5 text-sm" htmlFor={id + "-request"}>
            {t("workbench.modbus.requestFrame")}
            <Textarea
              id={id + "-request"}
              value={draft.request}
              maxLength={modbusFrameLimits.ascii * 3}
              className="min-h-16 font-mono text-xs"
              spellCheck={false}
              aria-invalid={issue?.startsWith("request") ?? false}
              aria-describedby={
                id + (issue?.startsWith("request") ? "-error" : "-help")
              }
              onChange={(event) =>
                change({ request: event.currentTarget.value })
              }
            />
          </label>
          <p id={id + "-help"} className="text-xs text-muted-foreground">
            {t("workbench.modbusServer.help")}
          </p>
          {issue ? (
            <p
              id={id + "-error"}
              className="text-sm text-destructive"
              role="alert"
            >
              {t("workbench.modbusServer.invalid", { path: issue })}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={!draft.request.trim() || !draft.definition.trim()}
            >
              {t("workbench.modbusServer.run")}
            </Button>
            <Button type="button" variant="outline" onClick={example}>
              {t("workbench.modbusServer.example")}
            </Button>
            {model ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setModel(undefined);
                  setResult(undefined);
                  setIssue(undefined);
                }}
              >
                {t("workbench.modbusServer.reset")}
              </Button>
            ) : null}
          </div>
        </fieldset>
      </form>
      {access ? (
        <section
          className="space-y-2 rounded-md border p-3"
          aria-label={t("workbench.modbusServer.live.title")}
        >
          {access.available ? (
            <>
              <fieldset
                className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                disabled={live.busy}
              >
                <label className="grid gap-1 text-sm">
                  {t("workbench.modbusServer.live.duration")}
                  <Input
                    type="number"
                    min={100}
                    max={120000}
                    value={Number.isNaN(duration) ? "" : duration}
                    onChange={(event) =>
                      setDuration(event.currentTarget.valueAsNumber)
                    }
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  {t("workbench.modbusServer.live.limit")}
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    value={Number.isNaN(requestLimit) ? "" : requestLimit}
                    onChange={(event) =>
                      setRequestLimit(event.currentTarget.valueAsNumber)
                    }
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  {t("workbench.modbusServer.live.delay")}
                  <Input
                    type="number"
                    min={0}
                    max={2000}
                    value={Number.isNaN(replyDelay) ? "" : replyDelay}
                    onChange={(event) =>
                      setReplyDelay(event.currentTarget.valueAsNumber)
                    }
                  />
                </label>
              </fieldset>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={startLive}
                  disabled={
                    live.busy ||
                    stop.busy ||
                    !draft.definition.trim() ||
                    !validTime ||
                    !validLimit ||
                    !validDelay
                  }
                >
                  {t("workbench.modbusServer.live.start")}
                </Button>
                {access.cancel && running ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={stopLive}
                    disabled={stop.busy || stopRequested}
                  >
                    {t("workbench.modbusServer.live.stop")}
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm">
              {t("workbench.modbusServer.live.unavailable")}
            </p>
          )}
          {live.busy ? (
            <p role="status">
              {t(
                stopRequested
                  ? "workbench.modbusServer.live.stopping"
                  : "workbench.modbusServer.live.running",
              )}
            </p>
          ) : null}
          {cancelled ? (
            <p role="status">{t("workbench.modbusServer.live.cancelled")}</p>
          ) : null}
          {live.error || stop.error ? (
            <p role="alert" className="text-destructive">
              {live.error ?? stop.error}
            </p>
          ) : null}
          {liveReport ? (
            <>
              <p role="status">
                {t(`workbench.modbusServer.live.reason.${liveReport.reason}`)} ·{" "}
                {liveReport.processed.length}
              </p>
              <ol className="space-y-1 text-xs">
                {liveReport.processed.map((frame) => (
                  <li key={String(frame.byteStart)}>
                    {t(`workbench.modbusServer.live.frame.${frame.status}`)}{" "}
                    <code>
                      #{String(frame.eventStart)}..{String(frame.eventEnd)} · [
                      {String(frame.byteStart)}, {String(frame.byteEnd)})
                    </code>
                    {frame.confirmed !== undefined
                      ? ` · ${t(frame.confirmed ? "workbench.modbusServer.live.txConfirmed" : "workbench.modbusServer.live.txUnknown")}`
                      : null}
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </section>
      ) : null}
      {result ? (
        <div className="space-y-2">
          <p role="status" className="text-sm">
            {result.status === "exception"
              ? t("workbench.modbusServer.exception", {
                  code: result.exceptionCode,
                })
              : result.status === "discarded"
                ? t("workbench.modbusServer.discarded", { path: result.path })
                : t(`workbench.modbusServer.result.${result.status}`)}
          </p>
          {"responseBytes" in result ? (
            <output
              aria-label={t("workbench.modbus.responseFrame")}
              className="block wrap-anywhere rounded-md border p-2 font-mono text-xs"
            >
              {formatHex(result.responseBytes)}
            </output>
          ) : null}
        </div>
      ) : null}
      {model ? (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {t("workbench.modbusServer.current")}
          </summary>
          <pre className="mt-2 max-h-52 overflow-auto rounded-md border p-2 text-xs">
            {JSON.stringify(model, null, 2)}
          </pre>
        </details>
      ) : null}
    </details>
  );
}
