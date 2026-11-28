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
  type ScriptDebugCommand,
  type ScriptDebugSnapshot,
  type ScriptDebugFrame,
} from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { nativeErrorCode, nativeErrorText } from "@/lib/native-error";
import { useI18n } from "@/providers/i18n";
import type { HostContextValue } from "@/providers/host-context";

type DebugScope = { id: string };
type Observation = { scope: DebugScope; snapshot?: ScriptDebugSnapshot };
type CommandState = { scope: DebugScope; revision: string; failure?: unknown };

export function useScriptDebug(
  operation: Operation | undefined,
  rpc: HostContextValue["scriptDebug"],
) {
  const id = operation?.operationId;
  const scope = useMemo(() => (id && rpc ? { id } : undefined), [id, rpc]);
  const [observation, setObservation] = useState<Observation>();
  const [commandState, setCommandState] = useState<CommandState>();
  const watch = useRef<{
    scope: DebugScope;
    controller: AbortController;
  } | null>(null);
  const requesting = useRef<AbortController | null>(null);
  const snapshot =
    observation?.scope === scope ? observation?.snapshot : undefined;
  const currentCommand =
    commandState?.scope === scope &&
    commandState?.revision === snapshot?.revision
      ? commandState
      : undefined;

  const inspect = useEffectEvent(
    async (owner: DebugScope, signal: AbortSignal) => {
      if (!rpc || operation?.operationId !== owner.id || scope !== owner)
        return;
      let projection: ScriptDebugSnapshot | undefined;
      try {
        const reply = await rpc(operation, { kind: "inspect" }, signal);
        if (reply.kind === "snapshot") projection = reply.snapshot;
      } catch {
        // An ordinary execution and a removed debugger have the same inspect outcome.
      }
      if (!signal.aborted)
        setObservation((known) => {
          if (
            known?.scope === owner &&
            known.snapshot?.revision === projection?.revision
          )
            return known;
          return { scope: owner, snapshot: projection };
        });
    },
  );

  useEffect(() => {
    if (!scope) return;
    const controller = new AbortController();
    watch.current = { scope, controller };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await inspect(scope, controller.signal);
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 200);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      watch.current = null;
    };
  }, [scope]);

  async function send(command: ScriptDebugCommand) {
    const owner = watch.current;
    if (
      !scope ||
      !owner ||
      owner.scope !== scope ||
      !rpc ||
      !operation ||
      snapshot?.phase !== "paused" ||
      command.revision !== snapshot.revision ||
      requesting.current === owner.controller ||
      (currentCommand && currentCommand.failure === undefined)
    )
      return;
    const { controller } = owner;
    requesting.current = controller;
    const pending = { scope, revision: command.revision };
    setCommandState(pending);
    try {
      const reply = await rpc(
        operation,
        { kind: "command", command },
        controller.signal,
      );
      if (reply.kind !== "accepted") throw new ContractValidationError();
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (
        nativeErrorCode(failure) === "PERMISSION_DENIED" ||
        nativeErrorCode(failure) === "SCRIPT_DEBUG_UNAVAILABLE"
      )
        setObservation({ scope });
      setCommandState({ ...pending, failure });
    } finally {
      if (requesting.current === controller) requesting.current = null;
    }
  }

  return {
    snapshot,
    send,
    waiting:
      currentCommand !== undefined && currentCommand.failure === undefined,
    failure: currentCommand?.failure,
  };
}

type Pause = Extract<ScriptDebugSnapshot, { phase: "paused" }>;
type CommandSender = (command: ScriptDebugCommand) => Promise<void>;
const executionCommands = [
  ["continue", "scriptDebug.continue"],
  ["stepOver", "scriptDebug.stepOver"],
  ["stepInto", "scriptDebug.stepInto"],
  ["stepOut", "scriptDebug.stepOut"],
] as const;

export function ScriptDebugActions({
  pause,
  disabled,
  send,
}: {
  pause: Pause;
  disabled: boolean;
  send: CommandSender;
}) {
  const { t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t("scriptDebug.controls")}
      className="flex min-w-0 flex-wrap gap-2"
    >
      {executionCommands.map(([action, label]) => (
        <Button
          key={action}
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void send({ action, revision: pause.revision })}
        >
          {t(label)}
        </Button>
      ))}
    </div>
  );
}

export function ScriptDebugDetails({
  pause,
  disabled,
  failure,
  send,
  locate,
}: {
  pause: Pause;
  disabled: boolean;
  failure?: unknown;
  send: CommandSender;
  locate?: (frame: ScriptDebugFrame) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const frame = pause.frames[pause.selectedFrame];
  return (
    <div className="grid min-w-0 gap-3 border-y border-border/70 py-3">
      {failure !== undefined && (
        <p role="alert" className="wrap-anywhere text-sm text-destructive">
          {nativeErrorText(failure, t)}
        </p>
      )}
      {frame && locate && (
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          onClick={() => locate(frame)}
        >
          {t("scriptDebug.locate", { line: frame.line, column: frame.column })}
        </Button>
      )}
      <div className="grid min-w-0 gap-3 @min-[33rem]/script:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section
          aria-labelledby={id + "-stack"}
          className="grid min-w-0 content-start gap-1"
        >
          <h3 id={id + "-stack"} className="text-sm font-medium">
            {t("scriptDebug.stack")}
          </h3>
          <ol className="max-h-32 min-w-0 space-y-1 overflow-y-auto px-1 pt-1 pb-2">
            {pause.frames.map(({ name, line, column }, index) => (
              <li key={index}>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-auto w-full justify-start whitespace-normal text-start wrap-anywhere font-mono"
                  aria-pressed={index === pause.selectedFrame}
                  disabled={disabled}
                  onClick={() => {
                    if (index !== pause.selectedFrame)
                      void send({
                        action: "inspectFrame",
                        revision: pause.revision,
                        frame: index,
                      });
                  }}
                >
                  {t("scriptDebug.frame", {
                    name: name || t("scriptDebug.anonymous"),
                    line,
                    column,
                  })}
                </Button>
              </li>
            ))}
          </ol>
        </section>
        <section
          aria-labelledby={id + "-variables"}
          className="grid min-w-0 content-start gap-1"
        >
          <h3 id={id + "-variables"} className="text-sm font-medium">
            {t("scriptDebug.variables")}
          </h3>
          {pause.variables.length ? (
            <dl className="max-h-40 min-w-0 space-y-1 overflow-y-auto font-mono text-xs">
              {pause.variables.map(({ name, preview, type }, index) => (
                <div
                  key={index}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 border-b border-border/60 py-1"
                >
                  <dt className="wrap-anywhere">{name}</dt>
                  <dd className="wrap-anywhere whitespace-pre-wrap text-muted-foreground">
                    {type === "string"
                      ? JSON.stringify(preview)
                      : preview || t("scriptDebug.noValue")}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("scriptDebug.noVariables")}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
