import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { defaults } from "@serial-workbench/contracts";
import type {
  SerialConfiguration,
  OperationSummary,
  Operation,
  WorkspaceDocument,
  SessionSnapshot,
  TerminalSettings,
  Target,
  TextEncoding,
} from "@serial-workbench/contracts";
import type {
  HostActionAvailability,
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { nativeErrorCode } from "@/lib/native-error";
import type { UserLogInput, UserLogModule } from "@/lib/user-log";
import type { ConnectionConfigurations } from "@/lib/client-connection-defaults";
import type { WriteWaitMode } from "@/lib/generated/bindings";
import { sendWaitMs } from "./send-wait";
import { connectionKey } from "@/lib/client-connection-defaults";
import type { WorkbenchFailure } from "./workbench-failure";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { InfoIcon, LockKeyholeIcon } from "lucide-react";
import type { WorkbenchLabels } from "./labels";
import { WorkbenchDialog, WorkbenchPanels } from "./workbench-dialog";
import { WorkbenchConnection } from "./workbench-connection";
import { operationFailureEventKey, WorkbenchNotice } from "./workbench-notice";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { WorkbenchCommands } from "./workbench-commands";
import { CaptureTailPanel, type CaptureTailReader } from "./capture-tail-panel";
import { captureTab, workspaceTabs } from "./capture-tabs";
import {
  useCaptureOperations,
  type CaptureTracker,
} from "./use-capture-operations";
import { SessionTabs, type SessionTab } from "./session-tabs";
import { connectSessionTabs, reconcileWorkspaceTabs } from "./workspace-model";
import { CONFIG_FIELDS } from "./serial-configuration";
import { StreamView, type StreamViewProps } from "./stream-view";
import { receiveEncodingFor } from "@/lib/text-encoding";
import { streamSourceKey } from "@/lib/stream-source";
import {
  historyAfter,
  historyPosition,
  historyTrimmedAfter,
  type HistoryPosition,
} from "@/lib/receive-history";
import { WorkspaceSendPanel } from "./workspace-send-panel";
import { createDraftStore } from "./draft-store";
import { ActivityPanel } from "./activity-panel";
import { WorkbenchLogPanel } from "./workbench-log-panel";
import type { ReceiptReader } from "./transfer-receipts";
import { type MetricsReader } from "./metrics-panel";
import type { CaptureStatusReader, CaptureStopper } from "./capture-status";
import { ReplayPanel, type ReplayPanelProps } from "./replay-panel";
import type { StreamPresentationLabels } from "./stream-presentation";
import type { OperationInputReader } from "./operation-input";
import {
  snapshotWindowLayout,
  type WindowViewModes,
} from "./window-layout-template";
import "./workbench.css";

type TabNameSource = { sourceKey?: string; sessionKey?: string; name?: string };
function sameActionInput(
  left: HostActionCheckInput,
  right: HostActionCheckInput,
) {
  return (
    left === right ||
    (left.actionId === right.actionId &&
      JSON.stringify(left) === JSON.stringify(right))
  );
}

type FriendlyTabName = { sourceKey: string; sessionKey: string; name: string };
function retainedTabName(
  retained: FriendlyTabName | undefined,
  source: TabNameSource | undefined,
  retired: boolean,
) {
  return retained &&
    (source?.sourceKey === retained.sourceKey ||
      (retired &&
        (!source?.sessionKey || source.sessionKey === retained.sessionKey)))
    ? retained.name
    : undefined;
}

export type WorkbenchHost = Pick<
  HostContextValue,
  | "state"
  | "refresh"
  | "open"
  | "send"
  | "takeover"
  | "watchSession"
  | "watchActions"
  | "checkAction"
  | "connection"
> & { trustedConnect?: HostContextValue["open"] };
export type WorkbenchTool =
  | "workspace"
  | "parameters"
  | "controls"
  | "devices"
  | "transfer"
  | "captureTools"
  | "diagnostics";
export type WorkbenchToolContext = {
  trackCapture: CaptureTracker;
  session?: SessionSnapshot;
  configuration: SerialConfiguration;
  configurationKey: string;
  configurationDisabled?: boolean;
  onConfigurationChange: (value: SerialConfiguration) => void;
  writeWaitMode: WriteWaitMode;
  onWriteWaitModeChange: (value: WriteWaitMode) => void;
  onInspectMetrics: () => void;
  onReconnect?: () => void;
  beforeReplace: () => Promise<boolean>;
  snapshotWorkspace?: (
    preservePresets?: boolean,
  ) => WorkspaceDocument | undefined;
  newViewDefaults?: { terminal: TerminalSettings; color: string };
  target?: Target;
  isReplay: boolean;
  items: readonly import("@serial-workbench/contracts").StreamItem[];
  openError?: WorkbenchFailure;
  onInspectBytes: () => void;
};
export type WorkspaceLayoutProps = {
  receiveHistory?: StreamViewProps["historyLimits"];
  onReceiveHistoryChange?: StreamViewProps["onHistoryLimitsChange"];
  connectionDefaults?: Readonly<ConnectionConfigurations>;
  connectionWaitModes?: Readonly<Record<string, WriteWaitMode>>;
  connectionDefaultsLoading?: boolean;
  onRememberConnection?: (
    hostId: string,
    deviceId: string,
    value: SerialConfiguration,
    writeWaitMode?: WriteWaitMode,
  ) => void;
  connectionStatus?: ReactNode;
  connectionLog?: UserLogInput;
  connectionRecovery?: {
    label: string;
    busy: boolean;
    onRetry: () => void;
  };
  formatError?: (error: { code?: string }) => string;
  unboundDraftMessage?: string;
  workspaceKey?: string;
  workspaceRevision?: string;
  workspaceSelection?: number;
  readCaptureTail?: CaptureTailReader;
  viewColor?: string;
  onSaveWindowLayout?: (
    value: WorkspaceDocument,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  terminalSettings?: TerminalSettings;
  presentationLabels?: StreamPresentationLabels;
  toolLabels?: Record<
    | WorkbenchTool
    | "more"
    | "chooseDevice"
    | "displayOptions"
    | "clearView"
    | "customLineEnding"
    | "customLineEndingHex"
    | "saveCurrentLayout"
    | "deviceListStale",
    string
  > & { saveCurrentLayoutHint?: string };
  renderTool?: (
    tool: WorkbenchTool,
    context: WorkbenchToolContext,
  ) => ReactNode;
  readFileReceipts?: ReceiptReader;
  readMetrics?: MetricsReader;
  readSessionMetrics?: HostContextValue["sessionMetrics"];
  readCaptureStatus?: CaptureStatusReader;
  readOperationInput?: OperationInputReader;
  replay?: Pick<ReplayPanelProps, "read" | "readRecord" | "control">;
  initialWorkspace?: WorkspaceDocument;
  preserveWorkspacePresets?: boolean;
  initialDrafts?: Readonly<Record<string, string>>;
  host: WorkbenchHost;
  labels: WorkbenchLabels;
  onSendFile?: (sessionId: string, signal?: AbortSignal) => Promise<void>;
  onStartCapture?: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<Operation | undefined>;
  onOpenReplay?: (signal?: AbortSignal) => Promise<void>;
  onCloseSession?: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  onCancelOperation?: (
    operation: Operation,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  onStopCapture?: CaptureStopper;
  onSaveDrafts?: (
    drafts: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ) => Promise<void>;
};
// Host view IDs cannot contain '/', so this key cannot alias another view ID.
const UNCONNECTED_VIEW_DRAFT = "view/unconnected";
function restoreViewDraftIdentity(
  drafts: Readonly<Record<string, string>>,
  workspace: WorkspaceDocument | undefined,
  initialUnconnected: string | undefined,
) {
  if (
    initialUnconnected !== undefined &&
    workspace?.views.some((view) => view.id === "unconnected") &&
    !Object.hasOwn(drafts, UNCONNECTED_VIEW_DRAFT)
  )
    return { ...drafts, [UNCONNECTED_VIEW_DRAFT]: initialUnconnected };
  return drafts;
}
export function WorkspaceLayout({
  receiveHistory,
  onReceiveHistoryChange,
  host,
  labels,
  initialWorkspace,
  preserveWorkspacePresets,
  initialDrafts = {},
  onSendFile,
  onStartCapture,
  onStopCapture,
  onSaveDrafts,
  readFileReceipts,
  readMetrics,
  readSessionMetrics,
  readCaptureStatus,
  readOperationInput,
  onOpenReplay,
  onCloseSession,
  onCancelOperation,
  replay,
  terminalSettings,
  presentationLabels,
  renderTool,
  toolLabels,
  workspaceKey,
  workspaceRevision,
  workspaceSelection,
  readCaptureTail,
  onSaveWindowLayout,
  viewColor,
  connectionStatus,
  connectionLog,
  connectionRecovery,
  connectionDefaults,
  connectionWaitModes,
  connectionDefaultsLoading = false,
  onRememberConnection,
  formatError,
  unboundDraftMessage,
}: WorkspaceLayoutProps) {
  const { state, watchSession, watchActions } = host;
  const workbenchRoot = useRef<HTMLElement>(null);
  const focusConnection = useCallback(() => {
    const root = workbenchRoot.current;
    const control =
      root?.querySelector<HTMLButtonElement>(
        ".workbench-device-select:not(:disabled)",
      ) ?? root?.querySelector<HTMLTextAreaElement>(".workbench-draft");
    control?.focus();
  }, []);
  const catalog = state.catalog;
  const watchAvailableActions = useCallback<HostContextValue["watchActions"]>(
    (inputs, listener) =>
      watchActions(inputs, (values) =>
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
    [watchActions, catalog],
  );
  const nativeOwnershipKey = JSON.stringify([
    host.connection?.attachment.hostId,
    host.connection?.attachment.instanceEpoch,
    host.connection?.generation,
    host.connection?.attachment.actorId,
    host.connection?.attachment.clientId,
  ]);
  const openedHere = useRef({
    key: nativeOwnershipKey,
    sessions: new Map<string, string>(),
  });
  if (openedHere.current.key !== nativeOwnershipKey)
    openedHere.current = { key: nativeOwnershipKey, sessions: new Map() };
  const existingLocalConnection = useCallback(
    (binding: WorkspaceDocument["bindings"][number] | undefined) => {
      if (!binding) return;
      return state.sessions.find(
        (session) =>
          session.state === "open" &&
          openedHere.current.sessions.get(session.sessionId) ===
            session.sessionEpoch &&
          state.devices.some(
            (device) =>
              device.deviceId === session.deviceId &&
              device.deviceId === binding.deviceId &&
              device.hostId === binding.hostId,
          ),
      );
    },
    [state.sessions, state.devices],
  );
  const restoreWorkspaceViews = useCallback(
    (document: WorkspaceDocument | undefined) => {
      return workspaceTabs(document).map((tab) => {
        const binding = document?.bindings.find(
          (item) => item.bindingId === tab.view?.bindingId,
        );
        const active = existingLocalConnection(binding);
        return active ? { ...tab, sessionId: active.sessionId } : tab;
      });
    },
    [existingLocalConnection],
  );
  const localDraftTabId = useRef<string | undefined>(undefined);
  const [{ tabs, selected }, setViews] = useState<{
    tabs: SessionTab[];
    selected?: string;
  }>(() => {
    const restored = restoreWorkspaceViews(initialWorkspace);
    if (initialWorkspace?.captures.length && initialDrafts.unconnected) {
      let localId = "unconnected";
      while (restored.some((tab) => tab.id === localId))
        localId = "_" + localId;
      localDraftTabId.current = localId;
      return { tabs: [{ id: localId }, ...restored], selected: localId };
    }
    return { tabs: restored, selected: restored[0]?.id };
  });
  const [draftStore] = useState(() =>
    createDraftStore(
      restoreViewDraftIdentity(
        { ...initialDrafts },
        initialWorkspace,
        initialDrafts.unconnected,
      ),
    ),
  );
  const setDrafts = draftStore.update;
  const setSavedDrafts = draftStore.setSaved;
  const dirty = useSyncExternalStore(
    draftStore.subscribe,
    draftStore.isDirty,
    draftStore.isDirty,
  );
  const [opening, setOpening] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const choosingResource = useRef(false);
  const [error, setError] = useState<Omit<WorkbenchFailure, "message">>();
  const lastFailure = useRef(0);
  const failure = error
    ? {
        ...error,
        message: formatError?.({ code: error.code }) ?? labels.unavailable,
      }
    : undefined;
  const [openError, setOpenError] = useState(false);
  const [following, setFollowing] = useState(true);
  const [connectionConfigurations, setConnectionConfigurations] = useState<
    Readonly<Record<string, SerialConfiguration>>
  >({});
  const configurationEdits = useRef(new Map<string, number>());
  const [writeWaitModes, setWriteWaitModes] = useState<
    Record<string, WriteWaitMode>
  >({});
  const [deviceChoice, setDeviceChoice] = useState("");
  const [dialog, setDialog] = useState<
    WorkbenchTool | "capture" | "activity" | "tasks" | "metrics" | "logs" | null
  >(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const [clearThrough, setClearThrough] = useState<
    ReadonlyMap<string, { source: string; position: HistoryPosition }>
  >(new Map());
  const [viewModes, setViewModes] = useState<WindowViewModes>({});
  const [savingLayout, setSavingLayout] = useState(false);
  const [unboundSendMode, setUnboundSendMode] = useState<"text" | "hex">();
  const [unboundSendEncoding, setUnboundSendEncoding] =
    useState<TextEncoding>();
  const unboundFormat = useRef({
    mode: unboundSendMode,
    encoding: unboundSendEncoding,
  });
  unboundFormat.current = {
    mode: unboundSendMode,
    encoding: unboundSendEncoding,
  };
  const [checkBytes, setCheckBytes] = useState<Uint8Array | null>(null);
  const [availability, setAvailability] = useState<
    readonly HostActionAvailability[]
  >([]);
  const focusRevision = useRef(0);
  const pending = useRef(new Set<AbortController>());
  const watched = useRef(new Map<string, () => void>());
  const seenOperations = useRef(
    new Set(state.operationSummaries.map((operation) => operation.operationId)),
  );
  const latestActivityId = useRef<string | undefined>(undefined);
  const latestActivityTime = useRef(
    state.operationSummaries.reduce(
      (latest, operation) => Math.max(latest, Date.parse(operation.acceptedAt)),
      -Infinity,
    ),
  );
  const previousWorkspace = useRef({
    key: workspaceKey,
    selection: workspaceSelection,
    document: initialWorkspace,
  });
  useEffect(() => {
    // A failed attachment has no replacement document. Keep local views and
    // drafts while the existing ready gates release readers and disable IPC.
    if (!initialWorkspace && state.status !== "ready") return;
    // Use the successfully read original as the view's baseline, never the
    // mutable local composition. Existing independent view drafts take priority.
    setDrafts((current) =>
      restoreViewDraftIdentity(
        current,
        initialWorkspace,
        initialDrafts.unconnected,
      ),
    );
    setSavedDrafts((current) =>
      restoreViewDraftIdentity(
        current,
        initialWorkspace,
        initialDrafts.unconnected,
      ),
    );
    const drafts = draftStore.snapshot();
    const before = previousWorkspace.current;
    previousWorkspace.current = {
      key: workspaceKey,
      selection: workspaceSelection,
      document: initialWorkspace,
    };
    if (
      before.key !== workspaceKey ||
      before.selection !== workspaceSelection
    ) {
      focusRevision.current++;
      setFollowing(false);
      setDeviceChoice("");
      setViewModes({});
      setConnectionConfigurations({});
      setViews((current) => {
        const restored = restoreWorkspaceViews(initialWorkspace);
        if (
          !before.document &&
          initialWorkspace &&
          current.selected &&
          drafts[current.selected]
        ) {
          return {
            tabs: [
              ...current.tabs,
              ...restored.filter(
                (tab) => !current.tabs.some((local) => local.id === tab.id),
              ),
            ],
            selected: current.selected,
          };
        }
        if (
          !before.document &&
          initialWorkspace &&
          !current.selected &&
          drafts.unconnected
        ) {
          let localId = "unconnected";
          while (restored.some((tab) => tab.id === localId))
            localId = `_${localId}`;
          localDraftTabId.current = localId;
          return {
            tabs: [{ id: localId }, ...restored],
            selected: localId,
          };
        }
        return { tabs: restored, selected: restored[0]?.id };
      });
    } else if (initialWorkspace && before.document !== initialWorkspace) {
      const previousViewIds = new Set(
        before.document?.views.map((view) => view.id),
      );
      setViews((current) => {
        const updated = new Map(
          reconcileWorkspaceTabs(
            current.tabs,
            before.document,
            initialWorkspace,
          ).map((tab) => [tab.id, tab]),
        );
        const next: SessionTab[] = [];
        for (const tab of current.tabs) {
          if (!tab.view) {
            const replacement = updated.get(tab.id);
            const binding = initialWorkspace.bindings.find(
              (item) => item.bindingId === replacement?.view?.bindingId,
            );
            const active = state.sessions.find(
              (item) => item.sessionId === tab.sessionId,
            );
            const matches =
              binding &&
              active &&
              state.devices.some(
                (item) =>
                  item.deviceId === active.deviceId &&
                  item.deviceId === binding.deviceId &&
                  item.hostId === binding.hostId,
              );
            next.push(
              replacement
                ? {
                    ...replacement,
                    ...(matches ? { sessionId: tab.sessionId } : {}),
                  }
                : tab,
            );
            continue;
          }
          const replacement = updated.get(tab.id);
          if (replacement) {
            const binding = initialWorkspace.bindings.find(
              (item) => item.bindingId === replacement.view?.bindingId,
            );
            const active = replacement.sessionId
              ? undefined
              : existingLocalConnection(binding);
            next.push(
              active
                ? { ...replacement, sessionId: active.sessionId }
                : replacement,
            );
          } else if (!previousViewIds.has(tab.id)) next.push(tab);
        }
        // 新增的文档视图加入标签，已被用户关闭的既有视图保持关闭。
        const visibleIds = new Set(next.map((tab) => tab.id));
        for (const tab of updated.values()) {
          if (!previousViewIds.has(tab.id) && !visibleIds.has(tab.id)) {
            const binding = initialWorkspace.bindings.find(
              (item) => item.bindingId === tab.view?.bindingId,
            );
            const active = existingLocalConnection(binding);
            next.push(active ? { ...tab, sessionId: active.sessionId } : tab);
          }
        }
        return {
          tabs: next,
          selected: next.some((tab) => tab.id === current.selected)
            ? current.selected
            : next[0]?.id,
        };
      });
    }
  }, [
    workspaceKey,
    workspaceSelection,
    initialWorkspace,
    state.status,
    state.sessions,
    state.devices,
    draftStore,
    setDrafts,
    setSavedDrafts,
    initialDrafts.unconnected,
    existingLocalConnection,
    restoreWorkspaceViews,
  ]);
  const captureOwnerScope = JSON.stringify([
    workspaceKey,
    workspaceSelection,
    host.connection?.attachment.hostId,
    host.connection?.attachment.instanceEpoch,
    host.connection?.generation,
    state.status,
  ]);
  // A CAS revision invalidates displayed bytes, not ownership of an ongoing capture.
  const captureScope = JSON.stringify([captureOwnerScope, workspaceRevision]);
  const trackCapture = useCaptureOperations(
    captureOwnerScope,
    state.operations,
    (reference) =>
      setViews((current) => {
        const tab = captureTab(reference);
        return current.tabs.some((value) => value.id === tab.id)
          ? current
          : { ...current, tabs: [...current.tabs, tab] };
      }),
  );
  const selectedTab = tabs.find((tab) => tab.id === selected);
  const selectedBinding = initialWorkspace?.bindings.find(
    (binding) => binding.bindingId === selectedTab?.view?.bindingId,
  );
  const isCapture = !!selectedTab?.captureRef;
  const draftKey = isCapture
    ? "unconnected"
    : selectedTab?.view?.id === "unconnected"
      ? UNCONNECTED_VIEW_DRAFT
      : selectedTab?.id === localDraftTabId.current &&
          !selectedTab?.view &&
          !selectedTab?.sessionId
        ? "unconnected"
        : (selectedTab?.id ?? "unconnected");
  const usesUnconnectedDraft = draftKey === "unconnected";
  const hasUnboundDraft = tabs.some(
    (tab) => tab.id === localDraftTabId.current && !tab.view && !tab.sessionId,
  );
  const sessionId = selectedTab?.sessionId;
  const session = state.sessions.find((value) => value.sessionId === sessionId);
  const stream = sessionId ? state.streams.get(sessionId) : undefined;
  const labelHostId = host.connection?.attachment.hostId;
  const labelHost = host.connection
    ? JSON.stringify([
        labelHostId,
        host.connection.attachment.instanceEpoch,
        host.connection.generation,
        host.connection.attachment.actorId,
        host.connection.attachment.clientId,
      ])
    : undefined;
  const tabNameSources = useMemo(
    () =>
      new Map(
        tabs.map((tab) => {
          const current = state.sessions.find(
            (value) => value.sessionId === tab.sessionId,
          );
          const device =
            current &&
            state.devices.find(
              (value) =>
                value.deviceId === current.deviceId &&
                (labelHostId === undefined || value.hostId === labelHostId),
            );
          const sessionKey = current
            ? JSON.stringify([
                current.sessionId,
                current.sessionEpoch,
                current.deviceId,
              ])
            : undefined;
          const source: TabNameSource = {
            sessionKey,
            sourceKey:
              labelHost && sessionKey
                ? JSON.stringify([labelHost, sessionKey])
                : undefined,
            name: device?.systemName.trim() ? device.systemName : undefined,
          };
          return [tab, source] as const;
        }),
      ),
    [tabs, state.sessions, state.devices, labelHost, labelHostId],
  );
  const [friendlyTabNames, setFriendlyTabNames] = useState<
    ReadonlyMap<SessionTab, FriendlyTabName>
  >(() => new Map());
  const retainRetiredNames = !host.connection && state.status !== "ready";
  useEffect(() => {
    setFriendlyTabNames((previous) => {
      // 只保留当前视图各一条已提交名称；关闭、替换视图和换代都会剪除旧记录。
      const next = new Map<SessionTab, FriendlyTabName>();
      for (const tab of tabs) {
        const source = tabNameSources.get(tab);
        const retained = previous.get(tab);
        if (source?.sourceKey && source.sessionKey && source.name) {
          next.set(
            tab,
            retained?.sourceKey === source.sourceKey &&
              retained.name === source.name
              ? retained
              : {
                  sourceKey: source.sourceKey,
                  sessionKey: source.sessionKey,
                  name: source.name,
                },
          );
        } else if (
          retained &&
          retainedTabName(retained, source, retainRetiredNames) !== undefined
        ) {
          next.set(tab, retained);
        }
      }
      return next.size === previous.size &&
        [...next].every(([tab, value]) => previous.get(tab) === value)
        ? previous
        : next;
    });
  }, [tabs, tabNameSources, retainRetiredNames]);
  const replayIds = new Set(
    state.operations.flatMap((operation) =>
      operation.actionId === "replay.open" &&
      operation.result?.kind === "opened"
        ? [operation.result.value.sessionId]
        : [],
    ),
  );
  const isReplay = !!sessionId && replayIds.has(sessionId);
  const uniqueSessionIds = [
    ...new Set(
      tabs
        .map((tab) => tab.sessionId)
        .filter(
          (id): id is string =>
            id !== undefined &&
            !replayIds.has(id) &&
            state.status === "ready" &&
            state.sessions.some(
              (session) =>
                session.sessionId === id && session.state !== "closed",
            ),
        ),
    ),
  ]
    .sort()
    .join("\0");
  useEffect(() => {
    const readers = watched.current;
    return () => {
      for (const stop of readers.values()) stop();
      readers.clear();
    };
  }, [watchSession]);
  useEffect(() => {
    const ids = uniqueSessionIds ? uniqueSessionIds.split("\0") : [];
    for (const [id, stop] of watched.current)
      if (!ids.includes(id)) {
        stop();
        watched.current.delete(id);
      }
    for (const id of ids)
      if (!watched.current.has(id))
        watched.current.set(
          id,
          watchSession(id, () => {}),
        );
  }, [uniqueSessionIds, watchSession]);
  useEffect(() => {
    const requests = pending.current;
    return () => {
      for (const controller of requests) controller.abort();
      requests.clear();
    };
  }, []);
  const selectSession = useCallback(
    (
      id: string,
      deviceId?: string,
      preferredViewId?: string,
      openedSession?: SessionSnapshot,
    ) => {
      const device = state.devices.find(
        (value) =>
          value.deviceId ===
          (deviceId ??
            state.sessions.find((value) => value.sessionId === id)?.deviceId),
      );
      const connected = connectSessionTabs(
        tabs,
        initialWorkspace,
        id,
        device,
        state.sessions,
        preferredViewId,
        openedSession,
      );
      const matchingTab = tabs.find((tab) => tab.id === connected.selected);
      const draftKey =
        matchingTab?.view?.id === "unconnected"
          ? UNCONNECTED_VIEW_DRAFT
          : connected.selected;
      if (!matchingTab) {
        const format = unboundFormat.current;
        setViewModes((current) => ({
          ...current,
          [connected.selected]: {
            ...current.unconnected,
            ...(format.mode ? { sendMode: format.mode } : {}),
            ...(format.encoding ? { sendEncoding: format.encoding } : {}),
            ...current[connected.selected],
          },
        }));
      }
      setDrafts((current) => {
        if (
          current[draftKey] !== undefined ||
          current.unconnected === undefined
        )
          return current;
        const { unconnected, ...rest } = current;
        return { ...rest, [draftKey]: unconnected };
      });
      setViews((current) => {
        if (
          current.tabs.some(
            (tab) =>
              tab.id === localDraftTabId.current && !tab.view && !tab.sessionId,
          )
        )
          current = {
            ...current,
            tabs: current.tabs.filter(
              (tab) =>
                tab.id !== localDraftTabId.current ||
                !!tab.view ||
                !!tab.sessionId,
            ),
          };
        const next = connectSessionTabs(
          current.tabs,
          initialWorkspace,
          id,
          device,
          state.sessions,
          preferredViewId,
          openedSession,
        );
        return next.selected === current.selected &&
          next.tabs.length === current.tabs.length &&
          next.tabs.every((tab, index) => tab === current.tabs[index])
          ? current
          : next;
      });
    },
    [initialWorkspace, state.devices, state.sessions, tabs, setDrafts],
  );
  const activitySessionId = useCallback(
    (summary: OperationSummary) => {
      const detail = state.operations.find(
        (operation) => operation.operationId === summary.operationId,
      );
      if (
        detail?.result?.kind === "opened" ||
        detail?.result?.kind === "session"
      )
        return detail.result.value.sessionId;
      return summary.revealTarget.sessionId;
    },
    [state.operations],
  );
  useEffect(() => {
    for (const operation of state.operationSummaries) {
      const accepted = Date.parse(operation.acceptedAt);
      if (
        !seenOperations.current.has(operation.operationId) &&
        accepted >= latestActivityTime.current
      ) {
        latestActivityId.current = operation.operationId;
        latestActivityTime.current = accepted;
      }
    }
    seenOperations.current = new Set(
      state.operationSummaries.map((operation) => operation.operationId),
    );
    const newest = state.operationSummaries.find(
      (operation) => operation.operationId === latestActivityId.current,
    );
    const id = newest ? activitySessionId(newest) : undefined;
    if (
      following &&
      id &&
      state.sessions.some((value) => value.sessionId === id)
    )
      selectSession(id);
  }, [
    state.operationSummaries,
    state.sessions,
    following,
    selectSession,
    activitySessionId,
  ]);
  const saveDrafts = async (signal?: AbortSignal) => {
    if (!onSaveDrafts) throw new Error(labels.unavailable);
    const snapshot = { ...draftStore.snapshot() };
    await onSaveDrafts(snapshot, signal);
    if (!signal?.aborted) setSavedDrafts(snapshot);
  };
  useUnsavedWork({
    id: "workbench-drafts",
    label: labels.draft,
    dirty,
    save: saveDrafts,
    discard: draftStore.discard,
  });
  function configurationKeyFor(id: string) {
    const device = state.devices.find((value) => value.deviceId === id);
    return connectionKey(
      device?.hostId ?? host.connection?.attachment.hostId ?? "",
      id,
    );
  }
  function rememberConfiguration(id: string, value: SerialConfiguration) {
    const key = configurationKeyFor(id);
    configurationEdits.current.set(
      key,
      (configurationEdits.current.get(key) ?? 0) + 1,
    );
    setConnectionConfigurations((current) => ({
      ...current,
      [configurationDraftKeyFor(id)]: value,
    }));
    const device = state.devices.find((item) => item.deviceId === id);
    if (device)
      onRememberConnection?.(device.hostId, id, value, waitModeFor(id));
  }
  function waitModeFor(id: string): WriteWaitMode {
    const key = configurationKeyFor(id);
    return writeWaitModes[key] ?? connectionWaitModes?.[key] ?? "automatic";
  }
  function rememberWaitMode(id: string, mode: WriteWaitMode) {
    setWriteWaitModes((current) => ({
      ...current,
      [configurationKeyFor(id)]: mode,
    }));
    const device = state.devices.find((value) => value.deviceId === id);
    if (device)
      onRememberConnection?.(
        device.hostId,
        id,
        requestedConfiguration(id),
        mode,
      );
  }
  function bindingForDevice(id: string) {
    const device = state.devices.find((value) => value.deviceId === id);
    const bindings =
      initialWorkspace?.bindings.filter(
        (binding) =>
          binding.deviceId === id && binding.hostId === device?.hostId,
      ) ?? [];
    return (
      (deviceChoice === id &&
      (session?.state !== "open" || session.deviceId === id)
        ? selectedBinding
        : undefined) ??
      bindings.find(
        (value) => value.bindingId === selectedTab?.view?.bindingId,
      ) ??
      bindings[0]
    );
  }
  function configurationDraftKeyFor(id: string) {
    const binding = bindingForDevice(id);
    return JSON.stringify([
      workspaceKey,
      configurationKeyFor(id),
      binding?.bindingId,
      binding && CONFIG_FIELDS.map((field) => binding.configuration[field]),
    ]);
  }
  function requestedConfiguration(id: string): SerialConfiguration {
    const binding = bindingForDevice(id);
    return (
      connectionConfigurations[configurationDraftKeyFor(id)] ??
      binding?.configuration ??
      connectionDefaults?.[configurationKeyFor(id)] ??
      state.sessions.find((value) => value.deviceId === id)?.configuration ??
      defaults.serialConfiguration
    );
  }
  function actionError(
    reason: unknown,
    module: UserLogModule,
    failedDeviceId?: string,
  ): Omit<WorkbenchFailure, "message"> {
    return {
      code: nativeErrorCode(reason),
      occurrence: ++lastFailure.current,
      module,
      eventKey: operationFailureEventKey(reason),
      deviceId: failedDeviceId,
      context: state.devices.find((value) => value.deviceId === failedDeviceId)
        ?.systemName,
    };
  }
  async function open(deviceId: string) {
    if (connectionDefaultsLoading) return;
    focusRevision.current++;
    setFollowing(false);
    const existing = state.sessions.find(
      (value) => value.deviceId === deviceId && value.state === "open",
    );
    if (opening !== null || state.status !== "ready") return;
    const revision = focusRevision.current;
    const controller = new AbortController();
    pending.current.add(controller);
    setOpening(deviceId);
    setError(undefined);
    setOpenError(true);
    const configurationKey = configurationKeyFor(deviceId);
    const configurationEdit =
      configurationEdits.current.get(configurationKey) ?? 0;
    try {
      const opened = await (host.trustedConnect ?? host.open)(
        deviceId,
        controller.signal,
        existing && !existing.readOnly
          ? existing.configuration
          : requestedConfiguration(deviceId),
      );
      // 只沿用本窗口明确打开且实例/会话代次一致的连接，不为其他会话补授权。
      if (
        controller.signal.aborted ||
        openedHere.current.key !== nativeOwnershipKey
      )
        return;
      openedHere.current.sessions.set(opened.sessionId, opened.sessionEpoch);
      if (
        !controller.signal.aborted &&
        !opened.readOnly &&
        opened.txGate === "ready" &&
        configurationEdit ===
          (configurationEdits.current.get(configurationKey) ?? 0)
      ) {
        rememberConfiguration(deviceId, opened.configuration);
      }
      if (!controller.signal.aborted && revision === focusRevision.current)
        selectSession(
          opened.sessionId,
          opened.deviceId,
          session?.state !== "open" || session.deviceId === opened.deviceId
            ? selected
            : undefined,
          opened,
        );
    } catch (reason) {
      if (!controller.signal.aborted) {
        setOpenError(true);
        setError(actionError(reason, "connection", deviceId));
      }
    } finally {
      pending.current.delete(controller);
      if (!controller.signal.aborted) setOpening(null);
    }
  }
  async function act(
    action: (signal: AbortSignal) => Promise<unknown>,
    module: UserLogModule = "application",
  ) {
    const controller = new AbortController();
    pending.current.add(controller);
    try {
      await action(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setOpenError(false);
        setError(actionError(reason, module));
      }
    } finally {
      pending.current.delete(controller);
    }
    return controller.signal.aborted;
  }
  async function choose(action: (signal: AbortSignal) => Promise<void>) {
    if (choosingResource.current) return;
    choosingResource.current = true;
    setChoosing(true);
    const aborted = await act(action);
    choosingResource.current = false;
    if (!aborted) setChoosing(false);
  }
  function locate(operation: OperationSummary) {
    const id = activitySessionId(operation);
    if (!id || !state.sessions.some((value) => value.sessionId === id)) return;
    focusRevision.current++;
    setFollowing(false);
    selectSession(id);
  }
  const disabled = state.status !== "ready" || connectionDefaultsLoading;
  const viewDevice = selectedTab?.source?.device ?? selectedBinding;
  const boundDevice =
    viewDevice &&
    state.devices.find(
      (device) =>
        device.deviceId === viewDevice.deviceId &&
        device.hostId === viewDevice.hostId,
    );
  const deviceId =
    deviceChoice ||
    state.devices.find((device) => device.deviceId === session?.deviceId)
      ?.deviceId ||
    (viewDevice
      ? (boundDevice?.deviceId ?? "")
      : (state.devices[0]?.deviceId ?? ""));
  const device = state.devices.find((value) => value.deviceId === deviceId);
  const connectionSession = state.sessions.find(
    (value) => value.deviceId === deviceId && value.state === "open",
  );
  const connectionConfiguration =
    connectionSession?.configuration ?? requestedConfiguration(deviceId);
  const connectionHostId = device?.hostId;
  const connectionSessionId = connectionSession?.sessionId;
  const connectionEpoch = connectionSession?.sessionEpoch;
  const connectionTarget = useMemo<Target | undefined>(
    () =>
      connectionHostId && connectionSessionId && connectionEpoch
        ? {
            hostId: connectionHostId,
            kind: "session",
            id: connectionSessionId,
            sessionId: connectionSessionId,
            sessionEpoch: connectionEpoch,
          }
        : undefined,
    [connectionHostId, connectionSessionId, connectionEpoch],
  );
  const connectionCloseInput = useMemo<HostActionCheckInput | undefined>(
    () =>
      connectionTarget
        ? { actionId: "session.close", target: connectionTarget, params: {} }
        : undefined,
    [connectionTarget],
  );
  const targetHostId =
    state.devices.find((value) => value.deviceId === session?.deviceId)
      ?.hostId ?? host.connection?.attachment.hostId;
  const targetSessionId = session?.sessionId;
  const targetSessionEpoch = session?.sessionEpoch;
  const currentWriteWaitMs = session?.configuration.writeWaitMs;
  const sendingConfiguration = session?.configuration;
  const writeWaitMode = session ? waitModeFor(session.deviceId) : "automatic";
  const checkedWriteWaitMs =
    sendingConfiguration && checkBytes?.length
      ? sendWaitMs(sendingConfiguration, checkBytes.length, writeWaitMode)
      : currentWriteWaitMs;
  const actorId = host.connection?.attachment.actorId ?? "";
  const target = useMemo<Target | undefined>(() => {
    return targetSessionId && targetSessionEpoch && targetHostId
      ? {
          hostId: targetHostId,
          kind: "session",
          id: targetSessionId,
          sessionId: targetSessionId,
          sessionEpoch: targetSessionEpoch,
        }
      : undefined;
  }, [targetHostId, targetSessionId, targetSessionEpoch]);
  const inputs = useMemo<HostActionCheckInput[]>((): HostActionCheckInput[] => {
    const values: HostActionCheckInput[] = [];
    if (target && checkedWriteWaitMs !== undefined) {
      if (checkBytes?.length)
        values.push({
          actionId: "session.tx",
          target,
          params: {
            bytesBase64: btoa(
              Array.from(checkBytes, (byte) => String.fromCharCode(byte)).join(
                "",
              ),
            ),
            writeWaitMs: checkedWriteWaitMs,
          },
        });
      values.push(
        { actionId: "session.close", target, params: {} },
        {
          actionId: "session.takeover",
          target,
          params: {
            actorId,
            reason: "user",
          },
        },
      );
    }
    if (connectionCloseInput) values.push(connectionCloseInput);
    return values;
  }, [target, checkedWriteWaitMs, checkBytes, actorId, connectionCloseInput]);
  useEffect(() => {
    setAvailability([]);
    let active = true;
    const stop = watchActions(inputs, (values) => {
      if (active) setAvailability(values);
    });
    return () => {
      active = false;
      stop();
    };
  }, [watchActions, inputs]);
  function allowed(actionId: string, checkedInput?: HostActionCheckInput) {
    const input =
      checkedInput ?? inputs.find((value) => value.actionId === actionId);
    return (
      !disabled &&
      !!input &&
      state.catalog.some(
        (spec) =>
          spec.actionId === actionId &&
          spec.targetKinds.includes(input.target.kind),
      ) &&
      availability.some(
        (value) =>
          sameActionInput(value.input, input) &&
          value.result?.allowed === true &&
          value.error === null,
      )
    );
  }
  function mayAttempt(actionId: string, checkedInput?: HostActionCheckInput) {
    const input =
      checkedInput ?? inputs.find((value) => value.actionId === actionId);
    const actionTarget =
      input?.target ?? (actionId === "session.tx" ? target : undefined);
    if (
      disabled ||
      !actionTarget ||
      !state.catalog.some(
        (spec) =>
          spec.actionId === actionId &&
          spec.targetKinds.includes(actionTarget.kind),
      )
    )
      return false;
    const current =
      input &&
      availability.find((value) => sameActionInput(value.input, input));
    // 未知只允许用户发起真实验权，不是授权票据；明确拒绝仍立即禁用。
    return (
      current?.result?.allowed !== false &&
      nativeErrorCode(current?.error) !== "PERMISSION_DENIED"
    );
  }
  const controlsDisabled =
    disabled || !session || session.readOnly || session.state !== "open";
  const connectionReadError = connectionSession
    ? nativeErrorCode(state.streams.get(connectionSession.sessionId)?.error)
    : undefined;
  const canRestoreAccess =
    !disabled &&
    !isCapture &&
    !!connectionSession &&
    !connectionSession.readOnly &&
    !replayIds.has(connectionSession.sessionId) &&
    connectionReadError !== "SOURCE_ENDED" &&
    (connectionReadError === "PERMISSION_DENIED" ||
      (!!connectionCloseInput &&
        availability.some(
          (value) =>
            sameActionInput(value.input, connectionCloseInput) &&
            (value.result?.allowed === false ||
              nativeErrorCode(value.error) === "PERMISSION_DENIED"),
        )));
  const sendAllowed = !isReplay && !!target && mayAttempt("session.tx");
  const cleared = clearThrough.get(selected ?? "");
  const firstItem = stream?.items[0];
  const streamIdentity =
    firstItem?.kind === "source" ? firstItem.event : firstItem?.gap;
  const historySource = streamIdentity ? streamSourceKey(streamIdentity) : "";
  const marker =
    cleared?.source === historySource ? cleared?.position : undefined;
  const items = useMemo(
    () => historyAfter(stream?.items ?? [], marker),
    [stream?.items, marker],
  );
  const changeViewFormat = (patch: WindowViewModes[string]) =>
    setViewModes((current) => ({
      ...current,
      [selected ?? "unconnected"]: {
        ...current[selected ?? "unconnected"],
        ...patch,
      },
    }));
  const receiveEncoding = receiveEncodingFor(
    viewModes[selected ?? "unconnected"]?.receiveEncoding,
    selectedTab?.view?.receiveEncoding,
    terminalSettings?.receiveEncoding,
  );
  const sendEncoding =
    (usesUnconnectedDraft
      ? unboundSendEncoding
      : (viewModes[selected ?? "unconnected"]?.sendEncoding ??
        selectedTab?.view?.sendEncoding)) ??
    terminalSettings?.sendEncoding ??
    "utf-8";
  function snapshotWorkspace(preservePresets = preserveWorkspacePresets) {
    if (
      !initialWorkspace ||
      previousWorkspace.current.key !== workspaceKey ||
      previousWorkspace.current.selection !== workspaceSelection
    )
      return;
    return snapshotWindowLayout(
      {
        ...initialWorkspace,
        captures: tabs.flatMap((tab) =>
          tab.captureRef ? [tab.captureRef] : [],
        ),
      },
      tabs.filter(
        (tab) =>
          !tab.captureRef &&
          (tab.view ||
            tab.source ||
            initialWorkspace.views.some((view) => view.id === tab.id) ||
            state.sessions.some(
              (session) =>
                session.sessionId === tab.sessionId &&
                state.devices.some(
                  (device) => device.deviceId === session.deviceId,
                ),
            )),
      ),
      state.sessions,
      state.devices,
      terminalSettings ?? defaults.settings.terminal,
      viewModes,
      viewColor,
      preservePresets,
    );
  }
  async function saveWindowLayout() {
    if (!initialWorkspace || !onSaveWindowLayout || savingLayout) return;
    setSavingLayout(true);
    const aborted = await act((signal) =>
      onSaveWindowLayout(snapshotWorkspace() ?? initialWorkspace, signal),
    );
    if (!aborted) setSavingLayout(false);
  }
  const showDialog = (
    next: NonNullable<typeof dialog>,
    returnPoint?: HTMLElement | null,
  ) => {
    if (returnPoint?.isConnected) dialogTrigger.current = returnPoint;
    else if (dialog === null)
      dialogTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    setDialog(next);
  };
  const closeSession = () =>
    session &&
    onCloseSession &&
    void act(
      (signal) => onCloseSession(session.sessionId, signal),
      "connection",
    );
  const takeover = () =>
    session && void act((signal) => host.takeover(session.sessionId, signal));
  function closeView(id: string) {
    focusRevision.current++;
    setFollowing(false);
    setViews((current) => {
      const index = current.tabs.findIndex((tab) => tab.id === id);
      const next = current.tabs.filter((tab) => tab.id !== id);
      return {
        tabs: next,
        selected:
          current.selected === id
            ? next[Math.min(index, next.length - 1)]?.id
            : current.selected,
      };
    });
  }
  return (
    <section
      className="workbench"
      ref={workbenchRoot}
      data-surface="panel"
      aria-label={labels.title}
    >
      <h1 className="sr-only">{labels.title}</h1>
      <WorkbenchCommands
        catalog={state.catalog}
        bindings={[
          {
            actionId: "session.close",
            label: labels.closeSession,
            target,
            available:
              allowed("session.close") &&
              !!onCloseSession &&
              !!session &&
              session.state !== "closed",
            run: closeSession,
          },
          {
            actionId: "session.takeover",
            label: labels.takeover,
            target,
            available:
              allowed("session.takeover") && !controlsDisabled && !isReplay,
            run: takeover,
          },
        ]}
      />
      <WorkbenchConnection
        recovery={connectionRecovery}
        labels={labels}
        toolLabels={toolLabels}
        workspaceName={initialWorkspace?.name ?? ""}
        onCloseOtherViews={
          tabs.length > 1
            ? () => {
                focusRevision.current++;
                setFollowing(false);
                setViews((current) => ({
                  tabs: current.tabs.filter(
                    (tab) => tab.id === current.selected,
                  ),
                  selected: current.selected,
                }));
              }
            : undefined
        }
        onCloseAllViews={
          tabs.length
            ? () => {
                focusRevision.current++;
                setFollowing(false);
                setViews({ tabs: [], selected: undefined });
                focusConnection();
              }
            : undefined
        }
        devices={state.devices}
        deviceId={deviceId}
        device={device}
        session={connectionSession}
        viewSessionId={
          isCapture
            ? tabs.find((tab) => tab.sessionId === connectionSession?.sessionId)
                ?.sessionId
            : session?.sessionId
        }
        viewTabs={
          <SessionTabs
            onEmptyFocus={focusConnection}
            tabs={tabs}
            selected={selected}
            canDuplicate={!disabled && !isCapture && !!session}
            labels={labels}
            onClose={closeView}
            name={(tab) => {
              if (tab.captureRef)
                return `${labels.captureTail} ${tabs.filter((value) => value.captureRef).findIndex((value) => value.id === tab.id) + 1} · ${labels.readOnly}`;
              if (
                tab.id === localDraftTabId.current &&
                !tab.view &&
                !tab.sessionId
              )
                return labels.draft;
              if (tab.view?.name.trim()) return tab.view.name;
              const source = tabNameSources.get(tab);
              return (
                source?.name ??
                retainedTabName(
                  friendlyTabNames.get(tab),
                  source,
                  retainRetiredNames,
                ) ??
                labels.sessionLabel
              );
            }}
            onSelect={(id) => {
              focusRevision.current++;
              setFollowing(false);
              setViews((current) => ({ ...current, selected: id }));
              setDeviceChoice("");
            }}
            onDuplicate={() => {
              if (!disabled && session && sessionId) {
                const device = state.devices.find(
                  (value) => value.deviceId === session.deviceId,
                );
                const tab = {
                  id: `view-${crypto.randomUUID()}`,
                  sessionId,
                  source: device ? { device, session } : selectedTab?.source,
                };
                setViews({ tabs: [...tabs, tab], selected: tab.id });
              }
            }}
          />
        }
        configuration={connectionConfiguration}
        opening={opening}
        readOnly={isCapture}
        disabled={disabled || isCapture}
        devicesStale={state.devicesStale}
        canClose={
          !isCapture &&
          !!connectionCloseInput &&
          mayAttempt("session.close", connectionCloseInput) &&
          !!onCloseSession &&
          connectionSession?.state !== "closed"
        }
        canRestoreAccess={canRestoreAccess}
        canControl={
          !disabled &&
          !isCapture &&
          !!connectionTarget &&
          connectionSession?.state === "open" &&
          !replayIds.has(connectionSession.sessionId)
        }
        canSave={
          !disabled &&
          !hasUnboundDraft &&
          !!onSaveWindowLayout &&
          !!initialWorkspace &&
          !savingLayout
        }
        canTakeover={
          !isCapture &&
          connectionSession?.sessionId === session?.sessionId &&
          !controlsDisabled &&
          !isReplay &&
          allowed("session.takeover")
        }
        canReplay={!disabled && !choosing && !!onOpenReplay}
        toolsAvailable={!!renderTool}
        onDeviceChange={(id) => {
          focusRevision.current++;
          setFollowing(false);
          setDeviceChoice(id);
        }}
        onTool={showDialog}
        onOpen={() => void open(deviceId)}
        onClose={() =>
          connectionSession &&
          onCloseSession &&
          void act(
            (signal) => onCloseSession(connectionSession.sessionId, signal),
            "connection",
          )
        }
        onSave={() => void saveWindowLayout()}
        onRefresh={() =>
          void act(() => host.refresh({ enumerateDevices: true }), "connection")
        }
        onUnavailableFocus={focusConnection}
        onTakeover={takeover}
        onReplay={() => {
          if (onOpenReplay) {
            setFollowing(true);
            void choose(onOpenReplay);
          }
        }}
      />

      <WorkbenchNotice
        noticeKey={`connection:${state.status}:${state.error?.message ?? ""}`}
        log={connectionLog}
      >
        {connectionStatus ??
          (state.error && (
            <p className="workbench-error" role="alert">
              {labels.unavailable}
            </p>
          ))}
      </WorkbenchNotice>
      <WorkbenchNotice
        noticeKey={`binding:${unboundDraftMessage ?? labels.bindingUnavailable}`}
      >
        {hasUnboundDraft && !isCapture && (
          <p className="px-3 py-1 text-sm text-muted-foreground" role="status">
            {unboundDraftMessage ?? labels.bindingUnavailable}
          </p>
        )}
      </WorkbenchNotice>
      <WorkbenchNotice
        noticeKey={`action:${failure?.occurrence ?? ""}`}
        eventKey={failure?.eventKey}
        log={
          failure
            ? {
                module: failure.module,
                level: "error",
                message:
                  formatError?.({ code: failure.code }) ?? labels.unavailable,
                code: failure.code,
                context: failure.context,
              }
            : undefined
        }
      >
        {failure && (
          <p className="workbench-error" role="alert">
            {failure.message}
          </p>
        )}
      </WorkbenchNotice>

      <div className="workbench-editor" data-surface="transparent">
        {selectedTab?.captureRef ? (
          <CaptureTailPanel
            key={captureScope + selectedTab.id}
            reference={selectedTab.captureRef}
            scopeKey={captureScope}
            ready={!disabled}
            read={readCaptureTail}
            watchActions={watchAvailableActions}
            labels={labels}
            terminalSettings={terminalSettings}
            presentationLabels={presentationLabels}
          />
        ) : isReplay && replay && session ? (
          <ReplayPanel
            key={`${session.sessionId}:${session.sessionEpoch}`}
            {...replay}
            terminalSettings={terminalSettings}
            presentationLabels={presentationLabels}
            session={session}
            labels={labels}
            disabled={disabled || session.state !== "open"}
          />
        ) : (
          <StreamView
            key={`${selected ?? "unconnected"}:${session?.sessionEpoch ?? ""}`}
            items={items}
            mode={
              viewModes[selected ?? "unconnected"]?.receiveMode ??
              selectedTab?.view?.receiveMode
            }
            onReceiveModeChange={(mode) =>
              changeViewFormat({ receiveMode: mode })
            }
            encoding={receiveEncoding}
            sendEncoding={sendEncoding}
            onEncodingChange={(value) =>
              changeViewFormat({ receiveEncoding: value })
            }
            initialMode={selectedTab?.view?.receiveMode}
            terminalSettings={terminalSettings}
            presentationLabels={presentationLabels}
            labels={labels}
            error={stream?.error}
            trimmed={
              stream?.removed
                ? historyTrimmedAfter(stream.removed, marker)
                : !!stream?.trimmed && !marker
            }
            historyLimits={receiveHistory}
            onHistoryLimitsChange={onReceiveHistoryChange}
            onOpenCapture={() => showDialog("capture")}
            onOpenActivity={() => showDialog("activity")}
            onClearView={() =>
              setClearThrough((current) =>
                new Map(current).set(selected ?? "", {
                  source: historySource,
                  position: historyPosition(
                    stream?.items ?? [],
                    stream?.removed,
                  ),
                }),
              )
            }
            captureActive={state.operations.some(
              (value) =>
                value.actionId === "capture.start" && value.state === "running",
            )}
            displayLabels={
              toolLabels
                ? {
                    displayOptions: toolLabels.displayOptions,
                    clearView: toolLabels.clearView,
                  }
                : undefined
            }
          />
        )}
      </div>
      <WorkspaceSendPanel
        formatError={formatError}
        deviceName={
          state.devices.find((value) => value.deviceId === session?.deviceId)
            ?.systemName
        }
        readOnly={isCapture}
        disconnectedReason={
          selectedTab?.view && !session && !boundDevice
            ? labels.bindingUnavailable
            : undefined
        }
        draftsDirty={dirty}
        onSaveDrafts={
          onSaveDrafts
            ? () => void act((signal) => saveDrafts(signal))
            : undefined
        }
        key={draftKey}
        draftCaption={isCapture ? labels.unconnectedDraft : undefined}
        draftActions={
          isCapture ? (
            <>
              {(hasUnboundDraft ||
                !state.devices.length ||
                state.devicesStale) && (
                <Popover>
                  <PopoverTrigger asChild>
                    <WorkbenchIconButton
                      label={
                        hasUnboundDraft
                          ? `${labels.unconnectedDraft} · ${toolLabels?.saveCurrentLayout ?? labels.saveDrafts} · ${labels.expand}`
                          : `${labels.unconnectedDraft} · ${labels.expand}`
                      }
                      tooltip={
                        hasUnboundDraft
                          ? (unboundDraftMessage ?? labels.bindingUnavailable)
                          : undefined
                      }
                    >
                      {hasUnboundDraft ? (
                        <LockKeyholeIcon aria-hidden="true" />
                      ) : (
                        <InfoIcon aria-hidden="true" />
                      )}
                    </WorkbenchIconButton>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    aria-label={labels.unconnectedDraft}
                    className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-96 max-w-[calc(100vw-2rem)] overflow-auto"
                  >
                    <PopoverTitle>{labels.unconnectedDraft}</PopoverTitle>
                    {hasUnboundDraft && (
                      <p role="status">
                        {unboundDraftMessage ?? labels.bindingUnavailable}
                      </p>
                    )}
                    {!state.devices.length && (
                      <p role="status">{labels.noDevices}</p>
                    )}
                    {state.devicesStale && (
                      <p role="status">
                        {toolLabels?.deviceListStale ?? labels.unavailable}
                      </p>
                    )}
                  </PopoverContent>
                </Popover>
              )}
            </>
          ) : undefined
        }
        initialMode={selectedTab?.view?.sendMode}
        mode={
          usesUnconnectedDraft
            ? unboundSendMode
            : (viewModes[selected ?? "unconnected"]?.sendMode ??
              selectedTab?.view?.sendMode)
        }
        onSendModeChange={(mode) =>
          usesUnconnectedDraft
            ? setUnboundSendMode(mode)
            : changeViewFormat({ sendMode: mode })
        }
        encoding={sendEncoding}
        onEncodingChange={(value) =>
          usesUnconnectedDraft
            ? setUnboundSendEncoding(value)
            : changeViewFormat({ sendEncoding: value })
        }
        terminalSettings={terminalSettings}
        presentationLabels={
          toolLabels
            ? {
                customLineEnding: toolLabels.customLineEnding,
                customLineEndingHex: toolLabels.customLineEndingHex,
              }
            : undefined
        }
        session={session}
        permissionAllowed={sendAllowed}
        onPreviewChange={setCheckBytes}
        drafts={draftStore}
        draftKey={draftKey}
        labels={labels}
        operations={state.operations}
        onSend={async (bytes, signal) => {
          if (isCapture || !session || !target)
            throw new Error(labels.unavailable);
          const writeWaitMs = sendWaitMs(
            session.configuration,
            bytes.length,
            writeWaitMode,
          );
          // 预览只服务界面提示；实际 invoke 仍由 Host 验权，且绑定点击时的会话代次。
          return host.send(target, bytes, signal, writeWaitMs);
        }}
        onSendFile={
          onSendFile &&
          !disabled &&
          !isReplay &&
          !isCapture &&
          session?.state === "open"
            ? () =>
                void choose((signal) => onSendFile(session.sessionId, signal))
            : undefined
        }
        fileBusy={choosing}
        onOpenTransfer={renderTool ? () => showDialog("transfer") : undefined}
        transferLabel={toolLabels?.transfer}
      />
      <WorkbenchDialog
        open={dialog !== null}
        scopeKey={JSON.stringify([
          workspaceKey,
          sessionId,
          session?.sessionEpoch,
          host.connection?.generation,
          dialog,
          dialog === "parameters" ? configurationKeyFor(deviceId) : undefined,
        ])}
        title={
          dialog
            ? (toolLabels?.[dialog as WorkbenchTool] ??
              labels[
                dialog as "capture" | "activity" | "tasks" | "metrics" | "logs"
              ])
            : ""
        }
        closeLabel={labels.closeView}
        returnFocus={dialogTrigger}
        onRequestClose={() => setDialog(null)}
      >
        {(beforeReplace) => (
          <>
            <WorkbenchPanels
              kind={dialog}
              state={state}
              labels={labels}
              disabled={disabled}
              readMetrics={readMetrics}
              readSessionMetrics={readSessionMetrics}
              metricsTarget={target}
              observationKey={JSON.stringify([
                host.connection?.attachment.hostId,
                host.connection?.attachment.instanceEpoch,
                host.connection?.generation,
              ])}
              readFileReceipts={readFileReceipts}
              watchActions={watchAvailableActions}
              onCancelOperation={onCancelOperation}
              capture={{
                watchActions: watchAvailableActions,
                startDisabled:
                  disabled ||
                  choosing ||
                  !session ||
                  session.state !== "open" ||
                  isReplay ||
                  isCapture,
                replayDisabled: disabled || choosing,
                onOpenReplay: onOpenReplay
                  ? () => {
                      latestActivityId.current = undefined;
                      setFollowing(true);
                      void choose(onOpenReplay);
                    }
                  : undefined,
                onStart:
                  onStartCapture && sessionId
                    ? () =>
                        void choose((signal) =>
                          trackCapture(
                            (waiting) => onStartCapture(sessionId, waiting),
                            signal,
                          ).then(() => {}),
                        )
                    : undefined,
                onStop: onStopCapture,
                readStatus: readCaptureStatus,
              }}
            />
            {dialog === "activity" && (
              <ActivityPanel
                operations={state.operationSummaries}
                currentActorId={host.connection?.attachment.actorId}
                describeTarget={(operation) => {
                  const targetSession = state.sessions.find(
                    (value) =>
                      value.sessionId ===
                      (operation.target.sessionId ??
                        operation.revealTarget.sessionId),
                  );
                  return state.devices.find(
                    (value) =>
                      value.deviceId ===
                      (targetSession?.deviceId ??
                        (operation.target.kind === "device"
                          ? operation.target.id
                          : undefined)),
                  )?.systemName;
                }}
                labels={labels}
                following={following}
                readInput={readOperationInput}
                canLocate={(operation) => !!activitySessionId(operation)}
                onLocate={(operation) => {
                  locate(operation);
                  setDialog(null);
                }}
                onFollowChange={(value) => {
                  setFollowing(value);
                  if (value) {
                    const latest = state.operationSummaries.reduce<
                      OperationSummary | undefined
                    >(
                      (candidate, operation) =>
                        !candidate ||
                        Date.parse(operation.acceptedAt) >=
                          Date.parse(candidate.acceptedAt)
                          ? operation
                          : candidate,
                      undefined,
                    );
                    const id = latest ? activitySessionId(latest) : undefined;
                    if (id) selectSession(id);
                  }
                }}
              />
            )}
            {dialog === "logs" && <WorkbenchLogPanel />}
            {dialog &&
              !["capture", "tasks", "metrics", "activity", "logs"].includes(
                dialog,
              ) &&
              renderTool?.(dialog as WorkbenchTool, {
                trackCapture,
                session: isCapture
                  ? undefined
                  : dialog === "parameters" || dialog === "controls"
                    ? connectionSession
                    : session,
                beforeReplace,
                snapshotWorkspace,
                newViewDefaults: {
                  terminal: terminalSettings ?? defaults.settings.terminal,
                  color: viewColor ?? defaults.settings.customAccent,
                },
                configuration: connectionConfiguration,
                configurationKey: configurationKeyFor(deviceId),
                configurationDisabled: !device || disabled,
                onConfigurationChange: (value) =>
                  rememberConfiguration(deviceId, value),
                writeWaitMode: waitModeFor(deviceId),
                onWriteWaitModeChange: (mode) =>
                  rememberWaitMode(deviceId, mode),
                onInspectMetrics: () => showDialog("metrics"),
                onReconnect:
                  !isReplay && !isCapture && !disabled && (session || deviceId)
                    ? () => void open(session?.deviceId ?? deviceId)
                    : undefined,
                target: isCapture
                  ? undefined
                  : dialog === "parameters" || dialog === "controls"
                    ? connectionTarget
                    : target,
                isReplay:
                  isCapture ||
                  (dialog === "parameters" || dialog === "controls"
                    ? !!connectionSession &&
                      replayIds.has(connectionSession.sessionId)
                    : isReplay),
                items,
                openError: openError ? failure : undefined,
                onInspectBytes: () => {
                  changeViewFormat({ receiveMode: "hex" });
                  setDialog(null);
                },
              })}
          </>
        )}
      </WorkbenchDialog>
    </section>
  );
}
