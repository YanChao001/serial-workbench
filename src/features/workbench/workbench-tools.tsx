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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FolderOpen, FolderSearch, RotateCw } from "lucide-react";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SessionControls } from "./session-controls";
import { DeviceLibrary } from "./device-library";
import { WorkspaceEditor } from "./workspace-editor";
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
  const pending = useRef<AbortController | null>(null);
  const [recent, setRecent] = useState<RecentList>();
  const recentReader = useRef(host.recentConnections);
  recentReader.current = host.recentConnections;
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState<string>();
  const [recentReload, setRecentReload] = useState(0);
  const workspaceReader = useRef(host.listWorkspaces);
  workspaceReader.current = host.listWorkspaces;
  const [workspaces, setWorkspaces] = useState<WorkspaceDocumentResult[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceDirectoryError, setWorkspaceDirectoryError] =
    useState<string>();
  const [workspaceReload, setWorkspaceReload] = useState(0);
  const [requestedWorkspaceId, setRequestedWorkspaceId] = useState("");
  const [workspaceTargetOpen, setWorkspaceTargetOpen] = useState(false);
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
  const documentKey = JSON.stringify([generation, stateScopeKey(base?.scope)]);
  useEffect(() => {
    setRecent(undefined);
    setWorkspaces([]);
    return () => pending.current?.abort();
  }, [generation]);
  useEffect(() => {
    setError(undefined);
    setBusy(false);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [tool, generation]);
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
  useEffect(() => {
    if (tool !== "workspace" || !ready) return;
    const controller = new AbortController();
    setWorkspaceLoading(true);
    setWorkspaceDirectoryError(undefined);
    void workspaceReader
      .current(controller.signal)
      .then(
        (values) => {
          if (!controller.signal.aborted) setWorkspaces(values);
        },
        (reason) => {
          if (!controller.signal.aborted)
            setWorkspaceDirectoryError(
              nativeErrorCode(reason) ?? "HOST_UNAVAILABLE",
            );
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setWorkspaceLoading(false);
      });
    return () => controller.abort();
  }, [tool, generation, ready, workspaceReload]);
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
  function loadWorkspace(workspaceId: string) {
    if (pending.current || !ready) return;
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
        if (result && !controller.signal.aborted) {
          setWorkspaceTargetOpen(false);
          onLoaded(result);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(nativeErrorCode(reason) ?? "OPERATION_FAILED");
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
        if (pending.current === controller) pending.current = null;
      });
  }
  if (tool === "parameters")
    return context.session ? (
      <SessionControls
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
        <div className="workbench-toolbar workbench-workspace-picker">
          <FolderOpen aria-hidden="true" className="size-4 shrink-0" />
          <Select
            value={base?.scope.target.id ?? ""}
            disabled={!ready || busy || (workspaceLoading && !base)}
            onValueChange={loadWorkspace}
          >
            <SelectTrigger
              aria-label={t("workbench.tools.chooseWorkspace")}
              aria-busy={workspaceLoading}
            >
              <SelectValue placeholder={t("workbench.tools.chooseWorkspace")} />
            </SelectTrigger>
            <SelectContent>
              {[
                ...new Map(
                  [...workspaces, ...(base ? [base] : [])].map((item) => [
                    item.scope.target.id,
                    item,
                  ]),
                ).values(),
              ].map((item, index) => (
                <SelectItem
                  key={item.scope.target.id}
                  value={item.scope.target.id}
                >
                  {item.document.value.name ||
                    (item.scope.target.id === "default"
                      ? t("workbench.tools.defaultWorkspace")
                      : `${t("workbench.tools.workspace")} ${index + 1}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Popover
            open={workspaceTargetOpen}
            onOpenChange={setWorkspaceTargetOpen}
          >
            <PopoverTrigger asChild>
              <WorkbenchIconButton
                label={t("workbench.tools.openOtherWorkspace")}
                disabled={!ready || busy}
              >
                <FolderSearch aria-hidden="true" />
              </WorkbenchIconButton>
            </PopoverTrigger>
            <PopoverContent
              className="workbench-detail-popover workbench-workspace-target"
              aria-label={t("workbench.tools.openOtherWorkspace")}
            >
              <label>
                <span>{t("workbench.tools.workspaceId")}</span>
                <Input
                  value={requestedWorkspaceId}
                  onChange={(event) =>
                    setRequestedWorkspaceId(event.target.value)
                  }
                  autoComplete="off"
                  maxLength={128}
                />
              </label>
              <Button
                size="sm"
                disabled={!ready || busy || !requestedWorkspaceId.trim()}
                onClick={() => loadWorkspace(requestedWorkspaceId.trim())}
              >
                {t("workbench.tools.load")}
              </Button>
            </PopoverContent>
          </Popover>
          {workspaceDirectoryError && (
            <WorkbenchIconButton
              label={t("common.retry")}
              onClick={() => setWorkspaceReload((value) => value + 1)}
            >
              <RotateCw aria-hidden="true" />
            </WorkbenchIconButton>
          )}
        </div>
        <WorkbenchNotice
          noticeKey={`workspace-directory:${workspaceReload}:${error ?? workspaceDirectoryError}`}
          log={{
            module: "workspace",
            level: "error",
            message: nativeErrorText(
              { code: error ?? workspaceDirectoryError },
              t,
            ),
            code: error ?? workspaceDirectoryError,
          }}
        >
          {error || workspaceDirectoryError ? (
            <span role="alert">
              {nativeErrorText({ code: error ?? workspaceDirectoryError }, t)}
            </span>
          ) : null}
        </WorkbenchNotice>
        {base && (
          <WorkspaceEditor
            key={documentKey}
            base={base}
            value={draft}
            labels={labels.workspace}
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
