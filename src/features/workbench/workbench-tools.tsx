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
import { saveTextExport } from "@/lib/tauri";
import { nativeErrorCode, nativeErrorText } from "@/lib/native-error";
import { stateScopeKey } from "@/lib/host-scope";
import { SerialConfigurationFields } from "./serial-configuration-fields";
import { validSerialConfiguration } from "./serial-configuration";
import { sendWaitMs } from "./send-wait";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { SessionControls } from "./session-controls";
import { DeviceLibrary } from "./device-library";
import { WorkspaceEditor } from "./workspace-editor";
import { WorkspacePicker } from "./workspace-picker";
import { addDeviceView, sameWorkspace } from "./workspace-model";
import { connectionKey } from "@/lib/client-connection-defaults";
import { TransferOptions } from "./transfer-options";
import { CaptureTools } from "./capture-tools";
import { DiagnosticPanel } from "./diagnostic-panel";
import { workbenchToolLabels } from "./tool-labels";
import { WorkbenchNotice } from "./workbench-notice";
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
  const labels = useMemo(() => workbenchToolLabels(t), [t]);
  const writeWaitLabels = {
    title: t("workbench.tools.writeWaitMode"),
    automatic: t("workbench.tools.writeWaitAutomatic"),
    fixed: t("workbench.tools.writeWaitFixed"),
  };
  const [recent, setRecent] = useState<RecentList>();
  const recentReader = useRef(host.recentConnections);
  recentReader.current = host.recentConnections;
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState<string>();
  const [recentReload, setRecentReload] = useState(0);
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
  const documentKey = JSON.stringify([generation, stateScopeKey(base?.scope)]);
  const materialized = useRef<string | undefined>(undefined);
  const workingSnapshot = useRef<
    { key: string; value: WorkspaceDocument } | undefined
  >(undefined);
  if (
    tool === "workspace" &&
    base &&
    materialized.current !== documentKey &&
    workingSnapshot.current?.key !== documentKey
  ) {
    const current = context.snapshotWorkspace?.(true);
    if (current) workingSnapshot.current = { key: documentKey, value: current };
  }
  const editorDocument =
    materialized.current !== documentKey &&
    workingSnapshot.current?.key === documentKey
      ? workingSnapshot.current.value
      : draft;
  useEffect(() => {
    if (tool !== "workspace" || !base || materialized.current === documentKey)
      return;
    const current =
      workingSnapshot.current?.key === documentKey
        ? workingSnapshot.current.value
        : context.snapshotWorkspace?.(true);
    if (!current) return;
    materialized.current = documentKey;
    if (!sameWorkspace(current, draft ?? base.document.value))
      onChange(current);
  }, [tool, base, documentKey, context, draft, onChange]);
  useEffect(() => {
    setRecent(undefined);
  }, [generation]);
  useEffect(() => {
    if (tool !== "devices" || !ready) return;
    const controller = new AbortController();
    setRecentLoading(true);
    setRecentError(undefined);
    void recentReader
      .current(controller.signal)
      .then(
        (value) => {
          if (!controller.signal.aborted) setRecent(value);
        },
        (reason) => {
          if (!controller.signal.aborted)
            setRecentError(nativeErrorCode(reason) ?? "HOST_UNAVAILABLE");
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setRecentLoading(false);
      });
    return () => controller.abort();
  }, [generation, tool, ready, recentReload]);
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
    if (!check.allowed) throw { code: "PERMISSION_DENIED" };
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
              : {
                  ...value,
                  result: {
                    actionId: value.input.actionId,
                    target: value.input.target,
                    allowed: false,
                  },
                },
          ),
        ),
      ),
    [watchHostActions, catalog],
  );
  if (tool === "controls" && !context.session) return null;
  if (tool === "parameters" || tool === "controls")
    return context.session ? (
      <SessionControls
        mode={tool}
        writeWaitLabels={writeWaitLabels}
        writeWaitMode={context.writeWaitMode}
        onWriteWaitModeChange={context.onWriteWaitModeChange}
        contextKey={generation}
        readInputs={host.sessionInputs}
        session={context.session}
        target={context.target}
        operations={host.state.operations}
        disabled={!ready || context.isReplay}
        labels={labels.parameters}
        invoke={invoke}
        waitForOperation={host.waitForOperation}
        watchActions={watchActions}
        onConfigurationApplied={context.onConfigurationChange}
      />
    ) : (
      <ConnectionOptions
        writeWaitLabels={writeWaitLabels}
        writeWaitMode={context.writeWaitMode}
        onWriteWaitModeChange={context.onWriteWaitModeChange}
        key={context.configurationKey}
        value={context.configuration}
        onApply={context.onConfigurationChange}
        labels={labels.parameters}
        disabled={context.configurationDisabled}
      />
    );
  if (tool === "devices")
    return (
      <>
        <WorkbenchNotice
          noticeKey={`device-list:${host.state.devicesStale}`}
          log={{
            module: "connection",
            level: "warning",
            message: t("workbench.tools.deviceListStale"),
          }}
        >
          {host.state.devicesStale ? (
            <span role="status">{t("workbench.tools.deviceListStale")}</span>
          ) : null}
        </WorkbenchNotice>
        <WorkbenchNotice
          noticeKey={`recent:${recentReload}`}
          log={{
            module: "connection",
            level: "error",
            code: recentError,
            message: recentError
              ? nativeErrorText({ code: recentError }, t)
              : "",
          }}
        >
          {recentError ? (
            <span role="alert">
              {nativeErrorText({ code: recentError }, t)}
            </span>
          ) : null}
        </WorkbenchNotice>
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
          recentLoading={recentLoading}
          recentError={recentError}
          onRetryRecent={() => setRecentReload((value) => value + 1)}
        />
      </>
    );
  if (tool === "workspace")
    return (
      <div className="workbench-workspace-tool">
        <WorkspacePicker
          key={`picker:${documentKey}`}
          host={host}
          base={base}
          value={editorDocument ?? base?.document.value}
          beforeReplace={context.beforeReplace}
          onLoaded={onLoaded}
          onBusyChange={setBusy}
          onCopySaved={() => {
            if (base) onChange(base.document.value);
          }}
        />
        {base && (
          <WorkspaceEditor
            key={documentKey}
            base={base}
            value={editorDocument}
            devices={host.state.devices.map((device) => ({
              value: device.deviceId,
              label: device.systemName,
            }))}
            onAddDevice={(document, deviceId) => {
              const device = host.state.devices.find(
                (item) => item.deviceId === deviceId,
              );
              if (!device) return;
              const configuration =
                document.bindings.find(
                  (binding) =>
                    binding.deviceId === deviceId &&
                    binding.hostId === device.hostId,
                )?.configuration ??
                host.state.sessions.find(
                  (session) => session.deviceId === deviceId,
                )?.configuration ??
                (context.configurationKey ===
                connectionKey(device.hostId, deviceId)
                  ? context.configuration
                  : defaults.serialConfiguration);
              return addDeviceView(
                document,
                device,
                configuration,
                context.newViewDefaults?.terminal ?? defaults.settings.terminal,
                context.newViewDefaults?.color ??
                  defaults.settings.customAccent,
              );
            }}
            labels={labels.workspace}
            bindingNames={Object.fromEntries(
              (editorDocument ?? base.document.value).bindings.map(
                (binding, index) => {
                  const device = host.state.devices.find(
                    (item) =>
                      item.hostId === binding.hostId &&
                      item.deviceId === binding.deviceId,
                  );
                  const alias = (
                    editorDocument ?? base.document.value
                  ).views.find(
                    (view) => view.bindingId === binding.bindingId,
                  )?.name;
                  const name =
                    device?.systemName ??
                    `${alias || `${labels.workspace.binding} ${index + 1}`} · ${labels.devices.offlineDevice}`;
                  return [
                    binding.bindingId,
                    `${name} · ${binding.configuration.baudRate}`,
                  ];
                },
              ),
            )}
            disabled={!ready || busy}
            maxImportBytes={host.connection?.attachment.limits.maxRequestBytes}
            onChange={onChange}
            onAcknowledged={onAcknowledged}
            onSave={host.saveWorkspace}
            onReload={async (signal) => {
              const result = await host.loadWorkspace(
                base.scope.target.id,
                signal,
              );
              signal?.throwIfAborted();
              onLoaded(result);
              return result;
            }}
            onPreviewImport={(json, signal) =>
              host.previewWorkspaceImport(base.scope.target.id, json, signal)
            }
            onExport={async (current, signal) => {
              const result = await host.exportWorkspace(
                current.scope.target.id,
                signal,
              );
              signal?.throwIfAborted();
              await saveTextExport(
                t("workbench.tools.configurationFileName"),
                result.json,
              );
            }}
          />
        )}
      </div>
    );
  if (tool === "transfer")
    return (
      <TransferOptions
        operations={host.state.operations}
        watchActions={watchActions}
        target={context.target}
        contextKey={`${generation}:${context.session?.sessionId}:${context.session?.sessionEpoch}`}
        labels={labels.transfer}
        writeWaitMs={sendWaitMs(
          context.session?.configuration ?? defaults.serialConfiguration,
          4096,
          context.writeWaitMode,
        )}
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
      <DiagnosticPanel
        device={host.state.devices.find(
          (device) =>
            device.deviceId ===
            (context.session?.deviceId ?? context.openError?.deviceId),
        )}
        labels={labels.diagnostics}
        items={context.items}
        session={context.session}
        openError={context.openError}
        streamError={
          context.session
            ? host.state.streams.get(context.session.sessionId)?.error
            : undefined
        }
        onInspectMetrics={context.onInspectMetrics}
        onReconnect={context.onReconnect}
        onInspectBytes={context.onInspectBytes}
      />
    </div>
  );
}

function ConnectionOptions({
  value,
  onApply,
  labels,
  disabled,
  writeWaitMode,
  onWriteWaitModeChange,
  writeWaitLabels,
}: {
  value: SerialConfiguration;
  onApply: (value: SerialConfiguration) => void;
  labels: import("./session-controls").SessionControlsLabels;
  disabled?: boolean;
  writeWaitMode: WorkbenchToolContext["writeWaitMode"];
  onWriteWaitModeChange: WorkbenchToolContext["onWriteWaitModeChange"];
  writeWaitLabels: import("./serial-configuration-fields").SerialConfigurationFieldsProps["writeWaitLabels"];
}) {
  const [draft, setDraft] = useState(value);
  const dirty = JSON.stringify(value) !== JSON.stringify(draft);
  const valid = validSerialConfiguration(draft);
  const id = useId();
  useUnsavedWork({
    id: "workbench-connection-options",
    label: labels.configuration,
    dirty: dirty && !valid,
    discard: () => setDraft(value),
  });
  return (
    <div className="workbench-connection-options">
      <fieldset disabled={disabled}>
        <legend className="sr-only">{labels.configuration}</legend>
        <SerialConfigurationFields
          writeWaitLabels={writeWaitLabels}
          writeWaitMode={writeWaitMode}
          onWriteWaitModeChange={onWriteWaitModeChange}
          value={draft}
          onChange={(value) => {
            setDraft(value);
            if (validSerialConfiguration(value)) onApply(value);
          }}
          labels={labels}
          id={id}
        />
      </fieldset>
      <p
        role={!valid ? "alert" : undefined}
        className="workbench-configuration-validation"
      >
        {!valid ? labels.invalidConfiguration : ""}
      </p>
    </div>
  );
}
