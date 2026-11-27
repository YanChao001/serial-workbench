import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  JsonValue,
  Operation,
  Target,
  WorkspaceDocumentResult,
  WorkspaceScriptReference,
  WorkspaceStartupPlan,
  WorkspaceStartupScript,
} from "@serial-workbench/contracts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { HostRequestError } from "@serial-workbench/host-client";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { nativeErrorCode, nativeErrorText } from "@/lib/native-error";
import { rpcJsonObject } from "@/lib/rpc-json";
import { isRecord } from "@/lib/settings-model";
import type {
  HostActionCheckInput,
  HostContextValue,
  HostInvocation,
} from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { operationText } from "./operation-text";
import { useToolAction } from "./transfer-capture-actions";
import { resolveViewDevice } from "./view-device";
import type { WorkbenchToolContext } from "./workspace-layout";

type StartupHost = Pick<
  HostContextValue,
  "readWorkspaceStartupPlan" | "checkAction" | "invoke"
> & {
  state: Pick<
    HostContextValue["state"],
    "status" | "devices" | "devicesStale" | "operations"
  >;
  connection?: { hostTarget: Target; attachment: { hostId: string } };
};

type StartupProps = {
  host: StartupHost;
  base: WorkspaceDocumentResult;
  connections: NonNullable<WorkbenchToolContext["startupConnections"]>;
};

export function WorkspaceStartup(props: StartupProps) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <section className="@container/workspace-startup grid min-h-0 min-w-0 shrink-0 gap-2">
      <Button
        className="justify-start self-start justify-self-start"
        size="sm"
        variant="outline"
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown aria-hidden="true" />
        ) : (
          <ChevronRight aria-hidden="true" />
        )}
        {t("workbench.startup.title")}
      </Button>
      {open && <StartupContents id={id} {...props} />}
    </section>
  );
}

function scriptKey(reference: WorkspaceScriptReference) {
  return `${reference.packageId}:${reference.actionId}`;
}

function StartupContents({
  id,
  host,
  base,
  connections,
}: StartupProps & { id: string }) {
  const { t } = useI18n();
  const [read, setRead] = useState<
    { plan: WorkspaceStartupPlan } | { error: string }
  >();
  const [refresh, setRefresh] = useState(0);
  const [selectedScript, setSelectedScript] = useState<string>();
  const readPlan = host.readWorkspaceStartupPlan;
  useEffect(() => {
    if (!readPlan) return;
    const controller = new AbortController();
    void readPlan(base, controller.signal).then(
      (plan) => {
        if (!controller.signal.aborted) setRead({ plan });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setRead({ error: nativeErrorText(error, t) });
      },
    );
    return () => controller.abort();
  }, [base, readPlan, refresh, t]);
  const bindings = new Map(
    base.document.value.bindings.map((binding) => [binding.bindingId, binding]),
  );
  const scripts = read && "plan" in read ? read.plan.scripts : [];
  const matched = scripts.find(
    ({ reference, status }) =>
      status === "matched" && scriptKey(reference) === selectedScript,
  );
  const usable = host.state.status === "ready";
  return (
    <div
      id={id}
      className="grid max-h-[min(40dvh,22rem)] min-w-0 items-start gap-4 overflow-y-auto rounded-md border p-3 text-sm @min-[34rem]/workspace-startup:grid-cols-2"
    >
      <section
        className="grid min-w-0 gap-2"
        aria-labelledby={id + "-connections"}
      >
        <h3 id={id + "-connections"} className="font-medium">
          {t("workbench.startup.connections")}
        </h3>
        {base.document.value.views.length === 0 && (
          <p className="text-muted-foreground">
            {t("workbench.startup.noViews")}
          </p>
        )}
        {base.document.value.views.length > 0 && (
          <ul className="grid gap-2">
            {base.document.value.views.map((view) => {
              const binding = bindings.get(view.bindingId);
              const device = resolveViewDevice(
                binding,
                host.state.devices,
                host.state.devicesStale,
                view.name,
              );
              const session = connections.sessions.get(view.id);
              return (
                <li
                  key={view.id}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b pb-2"
                >
                  <div className="min-w-0 wrap-anywhere">
                    <p>{view.name || view.id}</p>
                    <p className="text-muted-foreground">
                      {session
                        ? t("workbench.startup.connected")
                        : device && binding && !host.state.devicesStale
                          ? `${device.systemName} · ${binding.configuration.baudRate}`
                          : t("workbench.bindingUnmatched")}
                    </p>
                  </div>
                  {!session && (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={t("workbench.startup.connectView", {
                        view: view.name || view.id,
                      })}
                      disabled={
                        connections.busy ||
                        !usable ||
                        host.state.devicesStale ||
                        !device ||
                        !binding
                      }
                      onClick={() => {
                        if (device && binding)
                          connections.connect(
                            view.id,
                            device.deviceId,
                            binding.configuration,
                          );
                      }}
                    >
                      {t("workbench.startup.connect")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {readPlan && (
        <section
          className="grid min-w-0 gap-2"
          aria-labelledby={id + "-scripts"}
        >
          <h3 id={id + "-scripts"} className="font-medium">
            {t("workbench.configuration.scripts")}
          </h3>
          {!read && <p role="status">{t("workbench.startup.loading")}</p>}
          {read && "error" in read && (
            <div className="grid min-w-0 gap-2">
              <p role="alert">{read.error}</p>
              <Button
                size="sm"
                variant="outline"
                className="justify-self-start"
                onClick={() => {
                  setRead(undefined);
                  setRefresh((value) => value + 1);
                }}
              >
                {t("workbench.startup.retry")}
              </Button>
            </div>
          )}
          {read && "plan" in read && scripts.length === 0 && (
            <p className="text-muted-foreground">
              {t("workbench.startup.noScripts")}
            </p>
          )}
          {scripts.length > 0 && (
            <ul className="grid gap-2">
              {scripts.map(({ reference, status }) => (
                <li
                  key={scriptKey(reference)}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b pb-2"
                >
                  <div className="min-w-0 wrap-anywhere">
                    <p>
                      {reference.actionId} · {reference.version}
                    </p>
                    <p className="text-muted-foreground">
                      {t(`workbench.configuration.script.${status}`)}
                    </p>
                  </div>
                  {status === "matched" && (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-pressed={selectedScript === scriptKey(reference)}
                      aria-label={t("workbench.startup.selectScript", {
                        action: reference.actionId,
                      })}
                      onClick={() =>
                        setSelectedScript(
                          scriptKey(reference) === selectedScript
                            ? undefined
                            : scriptKey(reference),
                        )
                      }
                    >
                      {t("workbench.startup.select")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {matched && (
            <StartupScriptForm
              key={scriptKey(matched.reference)}
              {...{ base, host, connections }}
              script={matched}
            />
          )}
        </section>
      )}
    </div>
  );
}

function scriptParameters(json: string): Record<string, JsonValue> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (isRecord(value)) return rpcJsonObject(value);
  } catch {
    return undefined;
  }
}

function StartupScriptForm({
  host,
  base,
  connections,
  script,
}: StartupProps & {
  script: WorkspaceStartupScript;
}) {
  const { t } = useI18n();
  const id = useId();
  const [targetKey, setTargetKey] = useState("");
  const [json, setJson] = useState("{}");
  const scope = base.scope.target;
  const connection = host.connection;
  const targets: { key: string; label: string; target: Target }[] = [];
  if (connection && connection.attachment.hostId === scope.hostId) {
    if (script.targetKinds.includes("host"))
      targets.push({
        key: "host",
        label: t("workbench.startup.host"),
        target: connection.hostTarget,
      });
    if (script.targetKinds.includes("workspace"))
      targets.push({
        key: "workspace",
        label: t("workbench.startup.savedWorkspace"),
        target: scope,
      });
    if (script.targetKinds.includes("device") && !host.state.devicesStale) {
      const seen = new Set<string>();
      for (const view of base.document.value.views) {
        const binding = base.document.value.bindings.find(
          ({ bindingId }) => bindingId === view.bindingId,
        );
        const device = resolveViewDevice(
          binding,
          host.state.devices,
          false,
          view.name,
        );
        if (
          !device ||
          device.hostId !== scope.hostId ||
          seen.has(device.deviceId)
        )
          continue;
        seen.add(device.deviceId);
        targets.push({
          key: `device:${device.deviceId}`,
          label: device.systemName,
          target: {
            hostId: device.hostId,
            kind: "device",
            id: device.deviceId,
          },
        });
      }
    }
    if (script.targetKinds.includes("session")) {
      const views = new Map(
        base.document.value.views.map((view) => [view.id, view.name]),
      );
      for (const [viewId, session] of connections.sessions) {
        const label = views.get(viewId);
        if (label === undefined) continue;
        targets.push({
          key: `session:${viewId}:${session.sessionId}:${session.sessionEpoch}`,
          label: label || viewId,
          target: {
            hostId: scope.hostId,
            id: session.sessionId,
            kind: "session",
            sessionId: session.sessionId,
            sessionEpoch: session.sessionEpoch,
          },
        });
      }
    }
  }
  const {
    hostId,
    kind,
    id: targetId,
    sessionId,
    sessionEpoch,
  } = targets.find((choice) => choice.key === targetKey)?.target ?? {};
  const params = useMemo(() => scriptParameters(json), [json]);
  const actionId = script.reference.actionId;
  const input = useMemo(
    () =>
      hostId && kind && targetId && params
        ? {
            actionId,
            target: {
              hostId,
              kind,
              id: targetId,
              ...(sessionId && sessionEpoch ? { sessionId, sessionEpoch } : {}),
            },
            params,
          }
        : undefined,
    [actionId, params, hostId, kind, targetId, sessionId, sessionEpoch],
  );
  const currentInput = useRef(input);
  currentInput.current = input;
  return (
    <section
      className="grid min-w-0 gap-2 rounded-md bg-muted/40 p-2"
      aria-label={script.reference.actionId}
    >
      <label htmlFor={id + "-target"}>{t("workbench.startup.target")}</label>
      <Select
        value={kind ? targetKey : ""}
        onValueChange={setTargetKey}
        disabled={targets.length === 0}
      >
        <SelectTrigger id={id + "-target"} className="w-full min-w-0">
          <SelectValue placeholder={t("workbench.startup.selectTarget")} />
        </SelectTrigger>
        <SelectContent>
          {targets.map(({ key, label }) => (
            <SelectItem key={key} value={key}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {targets.length === 0 && (
        <p className="text-muted-foreground">
          {t("workbench.startup.noTarget")}
        </p>
      )}
      <label htmlFor={id + "-parameters"}>
        {t("workbench.startup.parameters")}
      </label>
      <Textarea
        id={id + "-parameters"}
        className="min-h-18 font-mono text-sm"
        spellCheck={false}
        value={json}
        onChange={(event) => setJson(event.target.value)}
        aria-invalid={!params}
      />
      {!params && (
        <p className="text-destructive">
          {t("workbench.startup.invalidParameters")}
        </p>
      )}
      <StartupScriptRun
        key={JSON.stringify([input?.target, params])}
        host={host}
        input={input}
        isCurrent={() => currentInput.current === input}
        selection={{
          workspaceId: scope.id,
          workspaceRevision: base.document.revision,
          reference: script.reference,
        }}
      />
    </section>
  );
}

function StartupScriptRun({
  host,
  input,
  isCurrent,
  selection,
}: {
  host: StartupHost;
  input?: HostActionCheckInput;
  isCurrent: () => boolean;
  selection: NonNullable<HostInvocation["workspaceStartup"]>;
}) {
  const { t } = useI18n();
  const action = useToolAction((error) => nativeErrorText(error, t));
  const [operation, setOperation] = useState<Operation>();
  const newest =
    operation &&
    (host.state.operations.find(
      ({ operationId }) => operationId === operation.operationId,
    ) ??
      operation);
  return (
    <>
      <Button
        type="button"
        size="sm"
        className="justify-self-start"
        aria-busy={action.busy}
        disabled={!input || action.busy || host.state.status !== "ready"}
        onClick={() => {
          if (!input || action.busy || host.state.status !== "ready") return;
          void action.run(async (signal) => {
            setOperation(undefined);
            const check = await host
              .checkAction(input, signal)
              .catch((error: unknown) => {
                // A pinned, dormant contribution can only activate on explicit invocation.
                if (nativeErrorCode(error) !== "UNSUPPORTED_CAPABILITY")
                  throw error;
              });
            signal.throwIfAborted();
            if (!isCurrent()) return;
            if (check && !check.allowed)
              throw new HostRequestError({
                code: "PERMISSION_DENIED",
                message: "Script launch is not authorized",
                retryable: false,
              });
            const accepted = await host.invoke(
              {
                ...input,
                executionMode: "independent",
                workspaceStartup: selection,
              },
              signal,
            );
            if (!signal.aborted && isCurrent()) setOperation(accepted);
          });
        }}
      >
        {t("workbench.startup.run")}
      </Button>
      {action.error && <p role="alert">{action.error}</p>}
      {newest && (
        <p role="status" className="wrap-anywhere">
          {operationText(t, () => "").states[newest.state]} ·{" "}
          {newest.operationId}
          {newest.error && <> · {nativeErrorText(newest.error, t)}</>}
        </p>
      )}
    </>
  );
}
