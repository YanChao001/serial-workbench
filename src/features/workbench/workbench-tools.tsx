import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaults,
  type SerialConfiguration,
} from "@serial-workbench/contracts";
import type {
  RecentList,
  WorkspaceDocument,
  WorkspaceDocumentResult,
  Target,
} from "@serial-workbench/contracts";
import type {
  HostContextValue,
  HostInvocation,
} from "@/providers/host-context";
import { useI18n } from "@/providers/i18n";
import { SerialConfigurationFields } from "./serial-configuration-fields";
import { validSerialConfiguration } from "./serial-configuration";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SessionControls } from "./session-controls";
import { DeviceLibrary } from "./device-library";
import { WorkspaceEditor } from "./workspace-editor";
import { TransferOptions } from "./transfer-options";
import { CaptureTools } from "./capture-tools";
import { DiagnosticPanel } from "./diagnostic-panel";
import { OperationActions } from "./operation-actions";
import { workbenchToolLabels } from "./tool-labels";
import type { WorkbenchTool, WorkbenchToolContext } from "./workspace-layout";

/** Owns no Host projection: tool components keep their drafts and Host owns receipts. */
export function WorkbenchTools({
  tool,
  context,
  host,
  base,
  draft,
  onChange,
  onAcknowledged,
  onLoaded,
}: {
  tool: WorkbenchTool;
  context: WorkbenchToolContext;
  host: HostContextValue;
  base?: WorkspaceDocumentResult;
  draft?: WorkspaceDocument;
  onChange: (value: WorkspaceDocument) => void;
  onAcknowledged: (result: WorkspaceDocumentResult) => void;
  onLoaded: (result: WorkspaceDocumentResult) => void;
}) {
  const { t } = useI18n();
  const labels = workbenchToolLabels(t);
  const pending = useRef<AbortController | null>(null);
  const [recent, setRecent] = useState<RecentList>();
  const [workspaceId, setWorkspaceId] = useState(
    base?.scope.target.id ?? "default",
  );
  const [exported, setExported] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const ready = host.state.status === "ready";
  const { hostId, kind, id, sessionId, sessionEpoch } = context.target ?? {};
  const captureEligible = Boolean(
    context.target &&
    context.session?.state === "open" &&
    !context.session.readOnly &&
    !context.isReplay,
  );
  // Sibling authorization invalidation rerenders the parent; equal session values keep this observation mounted.
  const captureSessionRefs = useMemo<Target[]>(() => {
    if (
      !captureEligible ||
      hostId === undefined ||
      kind === undefined ||
      id === undefined
    )
      return [];
    return [
      {
        hostId,
        kind,
        id,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(sessionEpoch === undefined ? {} : { sessionEpoch }),
      },
    ];
  }, [captureEligible, hostId, kind, id, sessionId, sessionEpoch]);
  const generation = JSON.stringify([
    host.connection?.attachment.hostId,
    host.connection?.attachment.instanceEpoch,
    host.connection?.generation,
  ]);
  useEffect(() => {
    setRecent(undefined);
    return () => pending.current?.abort();
  }, [generation]);
  const invoke: HostContextValue["invoke"] = async (input, signal) => {
    if (
      !host.state.catalog.some(
        (spec) =>
          spec.actionId === input.actionId &&
          spec.targetKinds.includes(input.target.kind),
      )
    )
      throw new Error("ACTION_UNAVAILABLE");
    const check = await host.checkAction(
      { actionId: input.actionId, target: input.target, params: input.params },
      signal,
    );
    signal?.throwIfAborted();
    if (!check.allowed) throw new Error("PERMISSION_DENIED");
    return host.invoke(input, signal);
  };
  const call = (
    actionId: string,
    target: Target,
    params: HostInvocation["params"],
    signal?: AbortSignal,
  ) =>
    invoke({ actionId, target, params, executionMode: "independent" }, signal);
  const refTarget = (ref: {
    hostId: string;
    kind: string;
    id: string;
  }): Target => ({ hostId: ref.hostId, kind: ref.kind, id: ref.id });
  const watchHostActions = host.watchActions;
  const catalog = host.state.catalog;
  const watchActions = useCallback<HostContextValue["watchActions"]>(
    (inputs, listener) =>
      watchHostActions(inputs, (values) =>
        listener(
          values.map((value) =>
            catalog.some(
              (spec) =>
                spec.actionId === value.input.actionId &&
                spec.targetKinds.includes(value.input.target.kind),
            )
              ? value
              : { ...value, result: null },
          ),
        ),
      ),
    [watchHostActions, catalog],
  );
  if (tool === "parameters")
    return context.session ? (
      <SessionControls
        contextKey={generation}
        readInputs={host.sessionInputs}
        session={context.session}
        target={context.target}
        operations={host.state.operations}
        disabled={!ready || context.isReplay}
        labels={labels.parameters}
        invoke={invoke}
        watchActions={watchActions}
      />
    ) : (
      <ConnectionOptions
        key={context.configurationKey}
        value={context.configuration}
        onApply={context.onConfigurationChange}
        labels={labels.parameters}
        applyLabel={t("workbench.tools.applyToConnection")}
        help={t("workbench.tools.nextConnection")}
      />
    );
  if (tool === "devices")
    return (
      <>
        <p role="status">
          {host.state.devicesStale
            ? t("workbench.tools.deviceListStale")
            : null}
        </p>
        <DeviceLibrary
          devices={host.state.devices}
          workspace={base}
          recent={recent}
          labels={labels.devices}
          disabled={!ready}
          onSaveFavorites={host.saveFavorites}
          onRebindDevice={
            host.state.devicesStale ? undefined : host.rebindDevice
          }
          onAcknowledged={onAcknowledged}
          onRefreshRecent={async (signal) => {
            const result = await host.recentConnections(signal);
            if (!signal?.aborted) setRecent(result);
          }}
        />
      </>
    );
  if (tool === "workspace")
    return (
      <div className="space-y-3">
        <div className="workbench-toolbar">
          <Input
            aria-label={t("workbench.tools.workspaceId")}
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          />
          <Button
            size="sm"
            disabled={!ready || busy || !workspaceId.trim()}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              const controller = new AbortController();
              pending.current = controller;
              void context
                .beforeReplace()
                .then((allowed) => {
                  if (!allowed || controller.signal.aborted) return;
                  return host.loadWorkspace(workspaceId, controller.signal);
                })
                .then((result) => {
                  if (result && !controller.signal.aborted) onLoaded(result);
                })
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error ? reason.message : String(reason),
                  ),
                )
                .finally(() => {
                  if (!controller.signal.aborted) setBusy(false);
                  if (pending.current === controller) pending.current = null;
                });
            }}
          >
            {t("workbench.tools.load")}
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
        {base && (
          <WorkspaceEditor
            base={base}
            value={draft}
            labels={labels.workspace}
            disabled={!ready || busy}
            onChange={onChange}
            onAcknowledged={onAcknowledged}
            onSave={host.saveWorkspace}
            onReload={(signal) =>
              host.loadWorkspace(base.scope.target.id, signal)
            }
            onPreviewImport={(json, signal) =>
              host.previewWorkspaceImport(base.scope.target.id, json, signal)
            }
            onExport={async (current, signal) => {
              const result = await host.exportWorkspace(
                current.scope.target.id,
                signal,
              );
              if (!signal?.aborted) setExported(result.json);
            }}
          />
        )}
        {exported && (
          <Textarea
            aria-label={t("workbench.tools.exportedJson")}
            value={exported}
            readOnly
          />
        )}
      </div>
    );
  if (tool === "transfer")
    return (
      <TransferOptions
        watchActions={watchActions}
        target={context.target}
        contextKey={`${generation}:${context.session?.sessionId}:${context.session?.sessionEpoch}`}
        labels={labels.transfer}
        writeWaitMs={
          context.session?.configuration.writeWaitMs ??
          defaults.serialConfiguration.writeWaitMs
        }
        disabled={
          !ready ||
          !context.target ||
          context.isReplay ||
          context.session?.state !== "open" ||
          context.session.readOnly
        }
        pickSource={(signal) => host.pickFile("source", signal)}
        onTransfer={
          context.target
            ? (params, signal) =>
                call("transfer.file", context.target!, params, signal)
            : undefined
        }
      />
    );
  if (tool === "captureTools")
    return (
      <CaptureTools
        watchActions={watchActions}
        contextKey={String(generation)}
        labels={labels.captureTools}
        sessionRefs={captureSessionRefs}
        disabled={!ready}
        operations={host.state.operations}
        pickFile={(role, signal) =>
          role === "captureTarget"
            ? host.pickFile(role, signal, context.session?.sessionId)
            : host.pickFile(role, signal)
        }
        readMetadata={host.fileMetadata}
        onStart={(params, signal) =>
          context
            .trackCapture(
              (waiting) =>
                call(
                  "capture.start",
                  refTarget(params.targetRef),
                  params,
                  waiting,
                ),
              signal,
            )
            .then((operation) => {
              if (!operation) throw new Error("HOST_UNAVAILABLE");
              return operation;
            })
        }
        onVerify={(params, signal) =>
          call("capture.verify", refTarget(params.captureRef), params, signal)
        }
        onRecover={(params, signal) =>
          call("capture.recover", refTarget(params.targetRef), params, signal)
        }
        onExport={(params, signal) =>
          call("capture.export", refTarget(params.captureRef), params, signal)
        }
        onReplay={(params, signal) =>
          call("replay.open", refTarget(params.captureRef), params, signal)
        }
      />
    );
  return (
    <div className="space-y-3">
      {error && <p role="alert">{error}</p>}
      <DiagnosticPanel
        labels={labels.diagnostics}
        items={context.items}
        session={context.session}
        openError={context.openError}
        streamError={
          context.session
            ? host.state.streams.get(context.session.sessionId)?.error
            : undefined
        }
        onRefresh={() =>
          void host
            .refresh()
            .catch((reason: unknown) =>
              setError(
                reason instanceof Error ? reason.message : String(reason),
              ),
            )
        }
        onInspectMetrics={context.onInspectMetrics}
        onReconnect={context.onReconnect}
        onInspectBytes={context.onInspectBytes}
      />
      {host.state.operations
        .filter(
          (operation) =>
            operation.state === "queued" ||
            operation.state === "running" ||
            operation.state === "cancel_requested",
        )
        .map((operation) => (
          <OperationActions
            watchActions={watchActions}
            key={operation.operationId}
            operation={operation}
            labels={{
              operation: t("workbench.tools.operation"),
              cancel: t("workbench.cancel"),
              cancelRequested: t("workbench.tools.cancelRequested"),
            }}
            disabled={!ready}
            onCancel={(operationId, signal) =>
              call(
                "operation.cancel",
                {
                  hostId: operation.executionHostId,
                  kind: "operation",
                  id: operationId,
                },
                { reason: "user" },
                signal,
              )
            }
          />
        ))}
    </div>
  );
}

function ConnectionOptions({
  value,
  onApply,
  labels,
  applyLabel,
  help,
}: {
  value: SerialConfiguration;
  onApply: (value: SerialConfiguration) => void;
  labels: import("./session-controls").SessionControlsLabels;
  applyLabel: string;
  help: string;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = JSON.stringify(value) !== JSON.stringify(draft);
  const valid = validSerialConfiguration(draft);
  const id = useId();
  useUnsavedWork({
    id: "workbench-connection-options",
    label: labels.configuration,
    dirty,
    save: async () => {
      throw new Error(labels.unavailable);
    },
    discard: () => setDraft(value),
  });
  return (
    <div className="space-y-3">
      <p>{help}</p>
      <SerialConfigurationFields
        value={draft}
        onChange={setDraft}
        labels={labels}
        id={id}
      />
      <Button size="sm" disabled={!valid} onClick={() => onApply(draft)}>
        {applyLabel}
      </Button>
      {!valid && <p role="alert">{labels.invalidConfiguration}</p>}
    </div>
  );
}
