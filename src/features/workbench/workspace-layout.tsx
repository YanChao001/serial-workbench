import type { StreamHighlightRule } from "./stream-highlight";
import type { TestSuiteWorkspace } from "./test-suite-tool";
import { TestSuiteSessionsContext } from "./test-suite-sessions";
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { defaults } from "@serial-workbench/contracts";
import type {
  ActivitySummary,
  SerialConfiguration,
  Operation,
  OpenParams,
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
import { ActivityNavigationContext } from "@/providers/commands-context";
import { bytesToBase64 } from "@/lib/base64";
import { nativeErrorCode } from "@/lib/native-error";
import type { UserLogInput, UserLogModule } from "@/lib/user-log";
import type { ConnectionConfigurations } from "@/lib/client-connection-defaults";
import type { WriteWaitMode } from "@/lib/generated/bindings";
import { sendWaitMs } from "./send-wait";
import { connectionKey } from "@/lib/client-connection-defaults";
import type { WorkbenchFailure } from "./workbench-failure";
import type { DiagnosticPanelProps } from "./diagnostic-panel";
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
import { supportsSessionTemplates } from "./session-templates";
import type { SessionTemplateConnection } from "./session-template-tool";
import { SendHistoryTool } from "./send-history-tool";
import { PluginTransportParameters } from "./plugin-transport-parameters";
import { operationFailureEventKey, WorkbenchNotice } from "./workbench-notice";
import { WorkbenchIconButton } from "./workbench-icon-button";
import type { CommandLibrarySource } from "./command-library";
import { WorkbenchCommands } from "./workbench-commands";
import { CaptureTailPanel, type CaptureTailReader } from "./capture-tail-panel";
import { captureTab, workspaceTabs } from "./capture-tabs";
import {
  useCaptureOperations,
  type CaptureTracker,
} from "./use-capture-operations";
import { SessionTabs, type SessionTab } from "./session-tabs";
import {
  connectSessionTabs,
  enrichWorkspacePorts,
  reconcileWorkspaceTabs,
  sameWorkspace,
} from "./workspace-model";
import { CONFIG_FIELDS } from "./serial-configuration";
import { StreamView, type StreamViewProps } from "./stream-view";
import type { ChartSourceSelection } from "./stream-chart-selection";
import { ansiPasteParams } from "./ansi-paste";
import { receiveEncodingFor } from "@/lib/text-encoding";
import { streamSourceKey } from "@/lib/stream-source";
import {
  historyAfter,
  historyPosition,
  historyTrimmedAfter,
  type HistoryPosition,
} from "@/lib/receive-history";
import { WorkspaceSendPanel } from "./workspace-send-panel";
import { useManualSendRecording } from "./use-manual-send-recording";
import {
  ManualRecordingControls,
  type ManualRecordingLabels,
} from "./manual-recording-controls";
import { createDraftStore } from "./draft-store";
import { restoreViewDraftIdentity, viewDraftKey } from "./draft-identity";
import { resolveViewDevice } from "./view-device";
import { ActivityPanel } from "./activity-panel";
import { WorkbenchLogPanel } from "./workbench-log-panel";
import type { ReceiptReader } from "./transfer-receipts";
import { type MetricsReader } from "./metrics-panel";
import type { CaptureStatusReader, CaptureStopper } from "./capture-status";
import { ReplayPanel, type ReplayPanelProps } from "./replay-panel";
import { useReplayComparison } from "./use-replay-comparison";
import type { StreamPresentationLabels } from "./stream-presentation";
import type { OperationInputReader } from "./operation-input";
import {
  snapshotWindowLayout,
  type WindowViewModes,
} from "./window-layout-template";
import "./workbench.css";

const ReplayComparisonDialog = lazy(() => import("./replay-comparison-dialog"));

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
  | "waitForOperation"
  | "readOperationSummary"
  | "takeover"
  | "watchSession"
  | "setReceiveIdleMs"
  | "watchActions"
  | "checkAction"
  | "connection"
> & {
  trustedConnect?: HostContextValue["open"];
  invoke?: HostContextValue["invoke"];
};
export type WorkbenchTool =
  | "workspace"
  | "sessionTemplates"
  | "parameters"
  | "controls"
  | "devices"
  | "transfer"
  | "captureTools"
  | "framing"
  | "repeatSend"
  | "commandSequence"
  | "testSuite"
  | "diagnostics";
type WorkbenchPanel =
  | WorkbenchTool
  | "capture"
  | "activity"
  | "tasks"
  | "metrics"
  | "logs"
  | "sendHistory";
type ActivityLocation = Pick<
  ActivitySummary,
  "operationId" | "target" | "revealTarget" | "actionId"
>;

function activityPanel(
  page: string,
  panel?: string,
): WorkbenchPanel | undefined {
  if (page !== "workbench") return;
  switch (panel) {
    case "workspace":
    case "sessionTemplates":
    case "parameters":
    case "controls":
    case "devices":
    case "transfer":
    case "captureTools":
    case "framing":
    case "repeatSend":
    case "commandSequence":
    case "diagnostics":
    case "capture":
    case "activity":
    case "tasks":
    case "sendHistory":
    case "metrics":
    case "logs":
      return panel;
  }
}

function editingField(element: EventTarget | null): boolean {
  return (
    element instanceof HTMLElement &&
    !!element.closest('textarea, input, [contenteditable="true"]')
  );
}

export type WorkbenchToolContext = {
  trackCapture: CaptureTracker;
  selectedViewId?: string;
  session?: SessionSnapshot;
  configuration: SerialConfiguration;
  configurationKey: string;
  configurationDisabled?: boolean;
  templateConnection?: SessionTemplateConnection;
  onConfigurationChange: (value: SerialConfiguration) => void;
  writeWaitMode: WriteWaitMode;
  draftBytes?: Uint8Array;
  sequenceRecording?: { revision: number; definition: string };
  testSuiteWorkspace?: TestSuiteWorkspace;
  onWriteWaitModeChange: (value: WriteWaitMode) => void;
  diagnostic?: Pick<
    DiagnosticPanelProps,
    "openTarget" | "receiveEncoding" | "onApplyEncoding"
  >;
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
  sourceItems?: readonly import("@serial-workbench/contracts").StreamItem[];
  openError?: WorkbenchFailure;
  onInspectBytes?: () => void;
  chartSelection?: ChartSourceSelection;
  onRevealChartSource?: (source: ChartSourceSelection) => void;
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
  workspaceId?: string;
  commandLibrary?: CommandLibrarySource;
  /** 持久草稿归属，不包含连接代次。 */
  draftScopeKey?: string;
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
    | Exclude<
        WorkbenchTool,
        | "framing"
        | "sessionTemplates"
        | "repeatSend"
        | "commandSequence"
        | "testSuite"
      >
    | "more"
    | "chooseDevice"
    | "displayOptions"
    | "clearView"
    | "customLineEnding"
    | "customLineEndingHex"
    | "saveCurrentLayout"
    | "deviceListStale",
    string
  > & {
    saveCurrentLayoutHint?: string;
    framing?: string;
    sessionTemplates?: string;
    repeatSend?: string;
    commandSequence?: string;
    testSuite?: string;
    manualRecording?: ManualRecordingLabels;
  };
  renderTool?: (
    tool: WorkbenchTool,
    context: WorkbenchToolContext,
  ) => ReactNode;
  readFileReceipts?: ReceiptReader;
  readTransferProgress?: HostContextValue["readTransferProgress"];
  readMetrics?: MetricsReader;
  readSessionMetrics?: HostContextValue["sessionMetrics"];
  readCaptureStatus?: CaptureStatusReader;
  readOperationInput?: OperationInputReader;
  replay?: Pick<
    ReplayPanelProps,
    "read" | "readRecord" | "control" | "playbackSupported"
  >;
  initialWorkspace?: WorkspaceDocument;
  savedWorkspace?: WorkspaceDocument;
  preserveWorkspacePresets?: boolean;
  initialDrafts?: Readonly<Record<string, string>>;
  /** 恢复前挂载完整界面，但不能修改或保存尚未确认的本地草稿。 */
  draftsReady?: boolean;
  host: WorkbenchHost;
  labels: WorkbenchLabels;
  onSendFile?: (sessionId: string, signal?: AbortSignal) => Promise<void>;
  onStartCapture?: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<Operation | undefined>;
  onOpenReplay?: (signal?: AbortSignal) => Promise<Operation | undefined>;
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
function initialViewState(
  workspace: WorkspaceDocument | undefined,
  unconnectedDraft: string | undefined,
  restored: SessionTab[],
) {
  if (workspace?.captures.length && unconnectedDraft) {
    let localId = "unconnected";
    while (restored.some((tab) => tab.id === localId)) localId = `_${localId}`;
    return {
      tabs: [{ id: localId }, ...restored],
      selected: localId,
      localDraftId: localId,
    };
  }
  return {
    tabs: restored,
    selected: restored[0]?.id,
    localDraftId: undefined,
  };
}
export function WorkspaceLayout({
  receiveHistory,
  onReceiveHistoryChange,
  host,
  labels,
  initialWorkspace,
  savedWorkspace,
  preserveWorkspacePresets,
  initialDrafts = {},
  draftsReady = true,
  onSendFile,
  onStartCapture,
  onStopCapture,
  onSaveDrafts,
  readFileReceipts,
  readTransferProgress,
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
  workspaceId,
  commandLibrary,
  draftScopeKey: receivedDraftScope,
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
  const [highlightRules, setHighlightRules] = useState<StreamHighlightRule[]>(
    [],
  );
  const revealActivityPage = useContext(ActivityNavigationContext);
  // Host 暂时离线会保留标签和本地编辑，草稿归属也必须随这些标签保留。
  const retainedDraftScope = useRef(receivedDraftScope);
  if (receivedDraftScope !== undefined)
    retainedDraftScope.current = receivedDraftScope;
  const draftScopeKey = retainedDraftScope.current;
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
    const restored = initialViewState(
      initialWorkspace,
      initialDrafts.unconnected,
      restoreWorkspaceViews(initialWorkspace),
    );
    localDraftTabId.current = restored.localDraftId;
    return { tabs: restored.tabs, selected: restored.selected };
  });
  const [draftStore] = useState(() =>
    createDraftStore(
      restoreViewDraftIdentity(
        { ...initialDrafts },
        initialWorkspace,
        initialDrafts.unconnected,
        draftScopeKey,
      ),
    ),
  );
  const setDrafts = draftStore.update;
  const setSavedDrafts = draftStore.setSaved;
  const draftsRestored = useRef(draftsReady);
  useLayoutEffect(() => {
    if (!draftsReady || draftsRestored.current) return;
    // 恢复在开放编辑前完成，正文及已保存基线一起发布，避免空稿覆盖和脏状态闪烁。
    draftStore.restoreSaved(
      restoreViewDraftIdentity(
        { ...initialDrafts },
        initialWorkspace,
        initialDrafts.unconnected,
        draftScopeKey,
      ),
    );
    if (initialWorkspace?.captures.length && initialDrafts.unconnected) {
      const restored = initialViewState(
        initialWorkspace,
        initialDrafts.unconnected,
        restoreWorkspaceViews(initialWorkspace),
      );
      localDraftTabId.current = restored.localDraftId;
      setViews({ tabs: restored.tabs, selected: restored.selected });
    }
    draftsRestored.current = true;
  }, [
    draftsReady,
    initialDrafts,
    initialWorkspace,
    draftStore,
    restoreWorkspaceViews,
    draftScopeKey,
  ]);
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
  const [mcpClient, setMcpClient] = useState<{
    actorId: string;
    name: string;
  }>();
  const [lastFollowedActivity, setLastFollowedActivity] = useState<string>();
  const [takeoverReceipt, setTakeoverReceipt] = useState<{
    scope: string;
    state: "pending" | "done";
  }>();
  const takeoverInProgress = useRef(false);
  const [pendingReplay, setPendingReplay] = useState<{
    operationId: string;
    focus: number;
  }>();
  const [connectionConfigurations, setConnectionConfigurations] = useState<
    Readonly<Record<string, SerialConfiguration>>
  >({});
  const configurationEdits = useRef(new Map<string, number>());
  const [writeWaitModes, setWriteWaitModes] = useState<
    Record<string, WriteWaitMode>
  >({});
  const [deviceSelection, setDeviceChoice] = useState<{
    workspace: string | undefined;
    view: string | undefined;
    deviceId: string;
  }>();
  const deviceChoice =
    deviceSelection &&
    deviceSelection.workspace === workspaceKey &&
    deviceSelection?.view === selected &&
    state.devices.some(
      (device) => device.deviceId === deviceSelection?.deviceId,
    )
      ? deviceSelection.deviceId
      : "";
  useEffect(() => {
    setDeviceChoice((choice) =>
      choice &&
      (choice.workspace !== workspaceKey ||
        choice.view !== selected ||
        !state.devices.some((device) => device.deviceId === choice.deviceId))
        ? undefined
        : choice,
    );
  }, [selected, workspaceKey, state.devices]);
  const [dialog, setDialog] = useState<WorkbenchPanel | null>(null);
  const suiteSessions = useContext(TestSuiteSessionsContext);
  const [suiteDraft, setSuiteDraft] = useState<TestSuiteWorkspace["draft"]>({
    definition: "",
    saved: "",
  });
  const [suiteSeries, setSuiteSeries] = useState<TestSuiteWorkspace["series"]>(
    [],
  );
  const [sequenceRecording, setSequenceRecording] = useState<{
    revision: number;
    definition: string;
  }>();
  const recordingRevision = useRef(0);
  const [chartLink, setChartLink] = useState<{
    scope: string;
    selection?: ChartSourceSelection;
    reveal?: ChartSourceSelection;
  }>();
  const [transportPrompt, setTransportPrompt] = useState<{
    deviceId: string;
    scope: string;
  }>();
  const transportScope = JSON.stringify([
    nativeOwnershipKey,
    workspaceKey,
    selected,
  ]);
  const promptDevice =
    transportPrompt?.scope === transportScope &&
    state.status === "ready" &&
    !state.devicesStale
      ? state.devices.find(
          (entry) =>
            entry.deviceId === transportPrompt.deviceId &&
            entry.fingerprint.transport === "plugin",
        )
      : undefined;
  useEffect(() => {
    if (transportPrompt && !promptDevice) setTransportPrompt(undefined);
  }, [promptDevice, transportPrompt]);
  const [editing, setEditing] = useState(false);
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
  const submittedLayout = useRef<{
    key: string | undefined;
    selection: number | undefined;
    document: WorkspaceDocument;
    formats: WindowViewModes;
  } | null>(null);
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
    draftStore.reidentify((current) =>
      restoreViewDraftIdentity(
        current,
        initialWorkspace,
        initialDrafts.unconnected,
        draftScopeKey,
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
      submittedLayout.current = null;
      focusRevision.current++;
      setFollowing(false);
      setDeviceChoice(undefined);
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
      const submitted = submittedLayout.current;
      const confirmsSubmission =
        submitted?.key === workspaceKey &&
        submitted?.selection === workspaceSelection &&
        sameWorkspace(initialWorkspace, submitted?.document);
      if (confirmsSubmission) submittedLayout.current = null;
      setViewModes((current) => {
        let next: Record<string, WindowViewModes[string]> | undefined;
        for (const previous of before.document?.views ?? []) {
          const view = initialWorkspace.views.find(
            (item) => item.id === previous.id,
          );
          const local = current[previous.id];
          if (!local) continue;
          const retained = { ...local };
          for (const field of [
            "receiveMode",
            "sendMode",
            "receiveEncoding",
            "sendEncoding",
          ] as const) {
            // 回执只结清提交时的覆盖；等待期间的新选择仍属于本地编辑。
            if (
              confirmsSubmission &&
              local[field] !== submitted?.formats[previous.id]?.[field]
            )
              continue;
            if (!view || previous[field] !== view[field])
              delete retained[field];
          }
          if (Object.keys(retained).length !== Object.keys(local).length) {
            next ??= { ...current };
            if (Object.keys(retained).length) next[previous.id] = retained;
            else delete next[previous.id];
          }
        }
        return next ?? current;
      });
      const previousViewIds = new Set(
        before.document?.views.map((view) => view.id),
      );
      const previousCaptureIds = new Set(
        before.document?.captures.map((reference) => captureTab(reference).id),
      );
      const nextCaptures = new Map(
        initialWorkspace.captures.map((reference) => {
          const tab = captureTab(reference);
          return [tab.id, tab] as const;
        }),
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
          if (tab.captureRef) {
            const replacement = nextCaptures.get(tab.id);
            if (replacement) next.push({ ...tab, ...replacement });
            else if (!previousCaptureIds.has(tab.id)) next.push(tab);
            continue;
          }
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
        for (const tab of nextCaptures.values()) {
          if (!previousCaptureIds.has(tab.id) && !visibleIds.has(tab.id))
            next.push(tab);
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
    draftScopeKey,
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
    : selectedTab?.id === localDraftTabId.current &&
        !selectedTab?.view &&
        !selectedTab?.sessionId
      ? "unconnected"
      : selectedTab
        ? viewDraftKey(draftScopeKey, selectedTab.id)
        : "unconnected";
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
  for (const active of state.sessions) {
    if (
      state.replaySessionEpochs?.get(active.sessionId) === active.sessionEpoch
    )
      replayIds.add(active.sessionId);
  }
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
      setDeviceChoice(undefined);
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
      const draftKey = viewDraftKey(draftScopeKey, connected.selected);
      const draftOwner = { views: [{ id: connected.selected }] };
      draftStore.reidentify((current) =>
        restoreViewDraftIdentity(current, draftOwner, undefined, draftScopeKey),
      );
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
      draftStore.claimUnconnected(draftKey);
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
    [
      initialWorkspace,
      state.devices,
      state.sessions,
      tabs,
      draftStore,
      draftScopeKey,
    ],
  );
  const resolveActivity = useCallback(
    (activity: ActivityLocation) => {
      const detail = activity.operationId
        ? state.operations.find(
            (item) => item.operationId === activity.operationId,
          )
        : undefined;
      const result = detail?.result;
      const opened =
        result?.kind === "opened" || result?.kind === "session"
          ? result.value
          : undefined;
      const id =
        opened?.sessionId ??
        activity.revealTarget.sessionId ??
        activity.target.sessionId;
      const epoch = opened?.sessionEpoch ?? activity.target.sessionEpoch;
      const session = state.sessions.find(
        (session) =>
          session.sessionId === id &&
          (epoch === undefined || session.sessionEpoch === epoch),
      );
      if (
        !session &&
        (id ||
          activity.actionId === "device.open" ||
          activity.actionId === "replay.open")
      )
        return;
      const { pageId, panelId } = activity.revealTarget;
      const panel = activityPanel(pageId, panelId);
      return {
        session,
        pageId,
        panel,
        canLocate: !!session || !!panel || pageId !== "workbench",
      };
    },
    [state.operations, state.sessions],
  );
  const showObservedSession = useCallback(
    (snapshot: SessionSnapshot) => {
      const device = state.devices.find(
        (item) => item.deviceId === snapshot.deviceId,
      );
      // 跟随只改变观看位置。人工草稿仍留在原标签，包括未连接的草稿。
      setViews((current) => {
        let nextTabs = current.tabs;
        if (!nextTabs.length && draftStore.snapshot().unconnected) {
          localDraftTabId.current = "unconnected";
          nextTabs = [{ id: localDraftTabId.current }];
        }
        const currentView = nextTabs.find(
          (tab) =>
            tab.id === current.selected && tab.sessionId === snapshot.sessionId,
        );
        return connectSessionTabs(
          nextTabs,
          initialWorkspace,
          snapshot.sessionId,
          device,
          state.sessions,
          currentView?.id,
          snapshot,
        );
      });
    },
    [state.devices, state.sessions, draftStore, initialWorkspace],
  );
  const showDialog = useCallback(
    (next: WorkbenchPanel, returnPoint?: HTMLElement | null) => {
      if (returnPoint?.isConnected) dialogTrigger.current = returnPoint;
      else if (dialog === null) {
        const active = document.activeElement;
        dialogTrigger.current = active instanceof HTMLElement ? active : null;
      }
      setSequenceRecording(undefined);
      setDialog(next);
    },
    [dialog],
  );
  const revealActivity = useCallback(
    (location: NonNullable<ReturnType<typeof resolveActivity>>) => {
      if (location.session) showObservedSession(location.session);
      revealActivityPage?.(location.pageId);
      if (location.panel) showDialog(location.panel);
      else setDialog(null);
    },
    [revealActivityPage, showDialog, showObservedSession],
  );
  useEffect(() => {
    if (
      state.status !== "ready" ||
      !mcpClient ||
      !following ||
      dialog ||
      editing ||
      !draftsReady ||
      opening
    )
      return;
    const activities = state.activities?.filter(
      (item) => item.actorId === mcpClient.actorId,
    );
    if (!activities?.length) return;
    const nextIndex =
      activities.findIndex((item) => item.activityId === lastFollowedActivity) +
      1;
    const next = activities[nextIndex];
    if (!next) return;
    const location = resolveActivity(next);
    // 目标尚不可定位时等待当前结果。若更晚活动已开始，晚到的结果只更新原活动。
    if (!location && nextIndex === activities.length - 1) return;
    setLastFollowedActivity(next.activityId);
    if (location) revealActivity(location);
  }, [
    state.activities,
    state.status,
    mcpClient,
    following,
    dialog,
    editing,
    draftsReady,
    opening,
    lastFollowedActivity,
    resolveActivity,
    revealActivity,
  ]);
  useEffect(() => {
    if (!pendingReplay) return;
    if (pendingReplay.focus !== focusRevision.current) {
      setPendingReplay(undefined);
      return;
    }
    const operation = state.operations.find(
      (item) => item.operationId === pendingReplay.operationId,
    );
    if (!operation) return;
    if (operation.result?.kind === "opened") {
      const { sessionId, sessionEpoch } = operation.result.value;
      const replaySession = state.sessions.find(
        (item) =>
          item.sessionId === sessionId && item.sessionEpoch === sessionEpoch,
      );
      if (!replaySession) return;
      showObservedSession(replaySession);
      setDialog(null);
    } else if (
      operation.state === "queued" ||
      operation.state === "running" ||
      operation.state === "cancel_requested"
    ) {
      return;
    }
    setPendingReplay(undefined);
  }, [pendingReplay, state.operations, state.sessions, showObservedSession]);
  const saveDrafts = async (signal?: AbortSignal) => {
    if (!draftsReady || !onSaveDrafts) throw new Error(labels.unavailable);
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
    const matchedView = resolveViewDevice(
      selectedBinding,
      state.devices,
      state.devicesStale,
      selectedTab?.view?.name,
    );
    const bindings =
      initialWorkspace?.bindings.filter(
        (binding) =>
          binding.deviceId === id && binding.hostId === device?.hostId,
      ) ?? [];
    return (
      ((deviceChoice === id || matchedView?.deviceId === id) &&
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
  async function open(
    deviceId: string,
    transportParams?: OpenParams["transportParams"],
    template?: SerialConfiguration,
  ) {
    if (connectionDefaultsLoading) return;
    focusRevision.current++;
    setFollowing(false);
    const existing = state.sessions.find(
      (value) => value.deviceId === deviceId && value.state === "open",
    );
    if (!draftsReady || opening !== null || state.status !== "ready") return;
    const device = state.devices.find((entry) => entry.deviceId === deviceId);
    if (
      template &&
      (existing ||
        state.devicesStale ||
        !supportsSessionTemplates(device?.fingerprint.transport))
    )
      return;
    if (
      device?.fingerprint.transport === "plugin" &&
      transportParams === undefined
    ) {
      if (state.devicesStale) return;
      const active = document.activeElement;
      if (dialog === null && active instanceof HTMLElement)
        dialogTrigger.current = active;
      setDialog(null);
      setTransportPrompt({ deviceId, scope: transportScope });
      return;
    }
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
      const connect = host.trustedConnect ?? host.open;
      const configuration =
        existing && !existing.readOnly
          ? existing.configuration
          : (template ?? requestedConfiguration(deviceId));
      const opened =
        transportParams === undefined
          ? await connect(deviceId, controller.signal, configuration)
          : await connect(
              deviceId,
              controller.signal,
              configuration,
              transportParams,
            );
      // 只沿用本窗口明确打开且实例/会话代次一致的连接，不为其他会话补授权。
      if (
        controller.signal.aborted ||
        openedHere.current.key !== nativeOwnershipKey
      )
        return;
      openedHere.current.sessions.set(opened.sessionId, opened.sessionEpoch);
      if (transportParams !== undefined)
        setTransportPrompt((prompt) =>
          prompt?.deviceId === deviceId && prompt.scope === transportScope
            ? undefined
            : prompt,
        );
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
  function openReplay() {
    if (!onOpenReplay) return;
    const focus = ++focusRevision.current;
    setFollowing(false);
    void choose(async (signal) => {
      const operation = await onOpenReplay(signal);
      if (operation && !signal.aborted && focus === focusRevision.current)
        setPendingReplay({ operationId: operation.operationId, focus });
    });
  }
  function locate(activity: ActivityLocation) {
    const location = resolveActivity(activity);
    if (!location?.canLocate) return;
    focusRevision.current++;
    setFollowing(false);
    revealActivity(location);
  }
  const disabled =
    !draftsReady || state.status !== "ready" || connectionDefaultsLoading;
  const viewDevice = selectedTab?.source?.device ?? selectedBinding;
  const boundDevice = resolveViewDevice(
    viewDevice,
    state.devices,
    state.devicesStale,
    selectedTab?.view?.name,
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
            bytesBase64: bytesToBase64(checkBytes),
            writeWaitMs: checkedWriteWaitMs,
          },
        });
      values.push({ actionId: "session.close", target, params: {} });
    }
    if (connectionCloseInput) values.push(connectionCloseInput);
    return values;
  }, [target, checkedWriteWaitMs, checkBytes, connectionCloseInput]);
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
      input?.target ??
      (actionId === "session.tx" || actionId === "transfer.paste"
        ? target
        : undefined);
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
  const historyHostId = host.connection?.attachment.hostId;
  const historyDestination =
    sendAllowed &&
    !isCapture &&
    target &&
    session?.state === "open" &&
    !session.readOnly &&
    session.txGate === "ready"
      ? {
          target,
          port:
            state.devices.find((item) => item.deviceId === session.deviceId)
              ?.systemName ?? session.deviceId,
          send: submitBytes,
          wait: host.waitForOperation,
        }
      : undefined;
  const recordingScope =
    renderTool &&
    toolLabels?.manualRecording &&
    draftsReady &&
    state.status === "ready" &&
    host.connection &&
    historyDestination
      ? JSON.stringify([
          nativeOwnershipKey,
          historyDestination.target.hostId,
          historyDestination.target.sessionId,
          historyDestination.target.sessionEpoch,
          session?.configurationRevision,
        ])
      : undefined;
  const recording = useManualSendRecording(
    recordingScope,
    historyDestination?.target,
    host.waitForOperation,
    toolLabels?.manualRecording?.title ?? "",
  );
  const invoke = host.invoke;
  const cancelOperation = onCancelOperation;
  const paste =
    sendAllowed &&
    session &&
    target &&
    invoke &&
    cancelOperation &&
    mayAttempt("transfer.paste")
      ? {
          start: (bytes: Uint8Array) =>
            invoke({
              actionId: "transfer.paste",
              target,
              params: ansiPasteParams(
                bytes,
                session.configuration,
                writeWaitMode,
              ),
              executionMode: "independent",
              expectedRevision: session.revision,
            }),
          wait: host.waitForOperation,
          cancel: async (operation: Operation) => {
            await cancelOperation(operation);
          },
        }
      : undefined;
  async function submitBytes(
    bytes: Uint8Array,
    signal?: AbortSignal,
    expectedRevision?: string,
    recordedWriteWaitMs?: string,
  ) {
    if (isCapture || !session || !target) throw new Error(labels.unavailable);
    const writeWaitMs =
      recordedWriteWaitMs ??
      sendWaitMs(session.configuration, bytes.length, writeWaitMode);
    // Host admission remains authoritative for the session epoch selected here.
    if (expectedRevision === undefined)
      return host.send(target, bytes, signal, writeWaitMs);
    return host.send(target, bytes, signal, writeWaitMs, expectedRevision);
  }
  function submitManualBytes(bytes: Uint8Array, signal?: AbortSignal) {
    if (!session) return submitBytes(bytes, signal);
    const writeWaitMs = sendWaitMs(
      session.configuration,
      bytes.length,
      writeWaitMode,
    );
    return recording.observe(bytes, writeWaitMs, (guardRevision) =>
      submitBytes(
        bytes,
        signal,
        guardRevision ? session.revision : undefined,
        writeWaitMs,
      ),
    );
  }
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
  const sourceItems = useMemo(
    () => stream?.sourceItems && historyAfter(stream.sourceItems, marker),
    [stream?.sourceItems, marker],
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
    if (
      !draftsReady ||
      !initialWorkspace ||
      !onSaveWindowLayout ||
      savingLayout
    )
      return;
    setSavingLayout(true);
    const submission = {
      key: workspaceKey,
      selection: workspaceSelection,
      document: enrichWorkspacePorts(
        snapshotWorkspace() ?? initialWorkspace,
        state.devices,
        state.devicesStale,
        savedWorkspace ?? initialWorkspace,
      ),
      formats: viewModes,
    };
    submittedLayout.current = submission;
    const aborted = await act(async (signal) => {
      try {
        await onSaveWindowLayout(submission.document, signal);
      } catch (reason: unknown) {
        if (submittedLayout.current === submission)
          submittedLayout.current = null;
        throw reason;
      }
    });
    if (!aborted) setSavingLayout(false);
  }
  const closeSession = () => {
    if (!draftsReady || !session || !onCloseSession) return;
    void act(
      (signal) => onCloseSession(session.sessionId, signal),
      "connection",
    );
  };
  const takeoverScope = JSON.stringify([
    host.connection?.generation,
    target,
    mcpClient?.actorId,
  ]);
  const takeoverState =
    takeoverReceipt?.scope === takeoverScope
      ? takeoverReceipt.state
      : undefined;
  const takeoverPort = state.devices.find(
    (device) => device.deviceId === session?.deviceId,
  )?.systemName;
  const browserTakeover = Boolean(host.connection?.browser);
  const canTakeover =
    !disabled &&
    !!target &&
    !!mcpClient &&
    !isReplay &&
    !isCapture &&
    (!browserTakeover ||
      (takeoverPort !== undefined && allowed("session.close"))) &&
    session?.state === "open";
  const takeover = () => {
    if (
      !canTakeover ||
      !target ||
      !mcpClient ||
      !host.takeover ||
      takeoverInProgress.current
    )
      return;
    takeoverInProgress.current = true;
    setFollowing(false);
    setTakeoverReceipt({ scope: takeoverScope, state: "pending" });
    const takeControl = host.takeover;
    const actorId = mcpClient.actorId;
    void act(async (signal) => {
      try {
        await takeControl(target, actorId, signal);
        if (!signal.aborted)
          setTakeoverReceipt({ scope: takeoverScope, state: "done" });
      } catch (error) {
        if (!signal.aborted) setTakeoverReceipt(undefined);
        throw error;
      } finally {
        takeoverInProgress.current = false;
      }
    }, "connection");
  };
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
  const comparisonScope = JSON.stringify([
    captureOwnerScope,
    host.connection?.attachment.actorId,
  ]);
  const comparison = useReplayComparison({
    scope: comparisonScope,
    hostId: labelHostId,
    sessions: state.sessions,
    ready: !disabled && state.status === "ready",
    watchActions: watchAvailableActions,
  });
  const chartScope = JSON.stringify([
    workspaceKey,
    selected,
    sessionId,
    session?.sessionEpoch,
    host.connection?.generation,
  ]);
  const currentChartLink =
    chartLink?.scope === chartScope ? chartLink : undefined;
  return (
    <section
      className="workbench"
      ref={workbenchRoot}
      onFocusCapture={(event) => setEditing(editingField(event.target))}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setEditing(false);
      }}
      data-surface="panel"
      aria-label={labels.title}
    >
      <h1 className="sr-only">{labels.title}</h1>
      {comparison.open ? (
        <Suspense>
          <ReplayComparisonDialog
            scope={comparisonScope}
            closeLabel={labels.closeView}
            comparison={comparison}
          />
        </Suspense>
      ) : null}
      <WorkbenchCommands
        catalog={state.catalog}
        bindings={[
          {
            actionId: "session.close",
            label: labels.closeSession,
            target,
            available:
              draftsReady &&
              allowed("session.close") &&
              !!onCloseSession &&
              !!session &&
              session.state !== "closed",
            run: closeSession,
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
        unmatchedDeviceName={
          !deviceId && viewDevice
            ? (selectedTab?.source?.device.systemName ??
              selectedTab?.view?.name ??
              labels.devices)
            : undefined
        }
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
              setDeviceChoice(undefined);
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
          draftsReady &&
          !isCapture &&
          !!connectionCloseInput &&
          mayAttempt("session.close", connectionCloseInput) &&
          !!onCloseSession &&
          connectionSession?.state !== "closed"
        }
        canRestoreAccess={draftsReady && canRestoreAccess}
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
        canReplay={!disabled && !choosing && !!onOpenReplay}
        toolsAvailable={draftsReady && !!renderTool}
        onDeviceChange={(id) => {
          focusRevision.current++;
          setFollowing(false);
          setDeviceChoice({
            workspace: workspaceKey,
            view: selected,
            deviceId: id,
          });
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
        onReplay={openReplay}
      />

      <WorkbenchNotice
        noticeKey={`connection:${state.status}:${state.error?.message ?? ""}`}
        log={connectionLog}
        duration={connectionRecovery?.busy ? Infinity : 5000}
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
            highlightRules={highlightRules}
            onHighlightRulesChange={setHighlightRules}
            terminalSettings={terminalSettings}
            presentationLabels={presentationLabels}
            session={session}
            labels={labels}
            disabled={disabled || session.state !== "open"}
            comparison={
              labels.replayComparison
                ? {
                    label: labels.replayComparison(comparison.count),
                    count: comparison.count,
                    stage: (side, sample) =>
                      comparison.stage(session, side, sample),
                    open: comparison.show,
                  }
                : undefined
            }
          />
        ) : (
          <StreamView
            key={`${selected ?? "unconnected"}:${session?.sessionEpoch ?? ""}`}
            items={items}
            chartSourceItems={sourceItems}
            chartReveal={currentChartLink?.reveal}
            onChartSelection={
              renderTool &&
              toolLabels?.framing &&
              session?.state === "open" &&
              !disabled
                ? (selection, trigger) => {
                    setChartLink({ scope: chartScope, selection });
                    showDialog("framing", trigger);
                  }
                : undefined
            }
            mode={
              viewModes[selected ?? "unconnected"]?.receiveMode ??
              selectedTab?.view?.receiveMode
            }
            onReceiveModeChange={(mode) =>
              changeViewFormat({ receiveMode: mode })
            }
            encoding={receiveEncoding}
            sendEncoding={sendEncoding}
            keyboard={
              sendAllowed &&
              host.connection &&
              session?.state === "open" &&
              session.txGate === "ready" &&
              !session.readOnly
                ? {
                    scope: JSON.stringify([
                      captureOwnerScope,
                      target,
                      session.configurationRevision,
                      writeWaitMode,
                    ]),
                    send: async (bytes, signal) => {
                      const admitted = await submitBytes(bytes, signal);
                      return host.waitForOperation(admitted, signal);
                    },
                    paste,
                  }
                : undefined
            }
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
            receiveIdleMs={stream?.receiveIdleMs}
            highlightRules={highlightRules}
            onHighlightRulesChange={setHighlightRules}
            onReceiveIdleMsChange={
              session?.state === "open" && host.setReceiveIdleMs
                ? (value) =>
                    host.setReceiveIdleMs?.(
                      session.sessionId,
                      session.sessionEpoch,
                      value,
                    )
                : undefined
            }
            onOpenCapture={(trigger) => showDialog("capture", trigger)}
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
        draftReadOnly={!draftsReady}
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
        commandLibrary={commandLibrary}
        draftActions={
          <>
            {renderTool && toolLabels?.manualRecording && (
              <ManualRecordingControls
                labels={toolLabels.manualRecording}
                recording={recording}
                available={recordingScope !== undefined}
                onReview={(definition, trigger) => {
                  showDialog("commandSequence", trigger);
                  setSequenceRecording({
                    revision: ++recordingRevision.current,
                    definition,
                  });
                  recording.discard();
                }}
              />
            )}
            {isCapture && (
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
            )}
          </>
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
        onSend={submitManualBytes}
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
        open={!!promptDevice}
        scopeKey={transportScope}
        title={labels.pluginTransportParameters}
        closeLabel={labels.closeView}
        returnFocus={dialogTrigger}
        onRequestClose={() => setTransportPrompt(undefined)}
      >
        {promptDevice && (
          <PluginTransportParameters
            key={promptDevice.deviceId}
            device={promptDevice.systemName}
            labels={labels}
            opening={opening === promptDevice.deviceId}
            error={
              openError && failure?.deviceId === promptDevice.deviceId
                ? failure?.message
                : undefined
            }
            onSubmit={(params) => {
              void open(promptDevice.deviceId, params);
            }}
          />
        )}
      </WorkbenchDialog>
      <WorkbenchDialog
        open={dialog !== null}
        scopeKey={JSON.stringify([
          workspaceKey,
          sessionId,
          session?.sessionEpoch,
          host.connection?.generation,
          dialog,
          dialog === "parameters" || dialog === "sessionTemplates"
            ? configurationKeyFor(deviceId)
            : undefined,
        ])}
        title={
          dialog
            ? (toolLabels?.[dialog as WorkbenchTool] ??
              labels[
                dialog as
                  | "capture"
                  | "activity"
                  | "tasks"
                  | "metrics"
                  | "logs"
                  | "sendHistory"
              ])
            : ""
        }
        closeLabel={labels.closeView}
        returnFocus={dialogTrigger}
        onRequestClose={() => {
          setSequenceRecording(undefined);
          setDialog(null);
        }}
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
              readTransferProgress={readTransferProgress}
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
                onOpenReplay: onOpenReplay ? openReplay : undefined,
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
                activities={state.activities}
                includeUnlistedOperations={Boolean(host.connection?.lanRoute)}
                mcpClient={mcpClient}
                onMcpChange={(client) => {
                  // 选择客户端时定位当前最后一次活动。之后按 Host 的开始顺序处理新增活动。
                  setLastFollowedActivity(
                    client
                      ? state.activities
                          ?.filter((item) => item.actorId === client.actorId)
                          .at(-2)?.activityId
                      : undefined,
                  );
                  setMcpClient(client);
                  setFollowing(true);
                }}
                canLocateQuery={(activity) =>
                  !!resolveActivity(activity)?.canLocate
                }
                onLocateQuery={locate}
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
                takeover={
                  canTakeover &&
                  host.takeover &&
                  (takeoverReceipt?.state !== "pending" ||
                    takeoverState === "pending")
                    ? {
                        label: takeoverPort
                          ? (browserTakeover
                              ? labels.requestTakeoverPort
                              : labels.takeoverPort)(takeoverPort)
                          : labels.takeover,
                        pendingLabel: browserTakeover
                          ? labels.browserTakeoverPending
                          : labels.takeoverPending,
                        start: takeover,
                        state: takeoverState,
                      }
                    : undefined
                }
                readInput={readOperationInput}
                canLocate={(operation) =>
                  !!resolveActivity(operation)?.canLocate
                }
                onLocate={locate}
                onFollowChange={setFollowing}
              />
            )}
            {dialog === "logs" && <WorkbenchLogPanel />}
            {dialog === "sendHistory" &&
              !disabled &&
              historyHostId &&
              readOperationInput && (
                <SendHistoryTool
                  key={JSON.stringify([
                    workspaceKey,
                    workspaceId,
                    historyHostId,
                    host.connection?.attachment.instanceEpoch,
                    host.connection?.generation,
                    target?.id,
                    target?.sessionEpoch,
                    session?.configurationRevision,
                    writeWaitMode,
                  ])}
                  hostId={historyHostId}
                  workspaceId={workspaceId}
                  summaries={state.operationSummaries}
                  sessions={state.sessions}
                  devices={state.devices}
                  readSummary={host.readOperationSummary}
                  destination={historyDestination}
                  read={readOperationInput}
                  watchActions={watchAvailableActions}
                  labels={labels}
                />
              )}
            {dialog &&
              ![
                "capture",
                "tasks",
                "metrics",
                "activity",
                "logs",
                "sendHistory",
              ].includes(dialog) &&
              renderTool?.(dialog as WorkbenchTool, {
                trackCapture,
                selectedViewId: isCapture ? undefined : selectedTab?.id,
                session: isCapture
                  ? undefined
                  : dialog === "parameters" ||
                      dialog === "controls" ||
                      dialog === "sessionTemplates"
                    ? connectionSession
                    : session,
                beforeReplace,
                snapshotWorkspace,
                sequenceRecording:
                  dialog === "commandSequence" ? sequenceRecording : undefined,
                testSuiteWorkspace:
                  dialog === "testSuite" && suiteSessions
                    ? {
                        ...suiteSessions,
                        draft: suiteDraft,
                        onDraftChange: setSuiteDraft,
                        series: suiteSeries,
                        onSeriesChange: setSuiteSeries,
                      }
                    : undefined,
                newViewDefaults: {
                  terminal: terminalSettings ?? defaults.settings.terminal,
                  color: viewColor ?? defaults.settings.customAccent,
                },
                configuration: connectionConfiguration,
                configurationKey: configurationKeyFor(deviceId),
                configurationDisabled: !device || disabled,
                templateConnection:
                  dialog === "sessionTemplates"
                    ? {
                        deviceId: device?.deviceId,
                        deviceName: device?.systemName,
                        eligible: supportsSessionTemplates(
                          device?.fingerprint.transport,
                        ),
                        canOpen:
                          !disabled &&
                          !state.devicesStale &&
                          opening === null &&
                          !connectionSession &&
                          supportsSessionTemplates(
                            device?.fingerprint.transport,
                          ),
                        opening: opening === deviceId,
                        open: (configuration) =>
                          void open(deviceId, undefined, configuration),
                        close: () => setDialog(null),
                      }
                    : undefined,
                onConfigurationChange: (value) =>
                  rememberConfiguration(deviceId, value),
                writeWaitMode: waitModeFor(deviceId),
                draftBytes:
                  dialog === "repeatSend"
                    ? (checkBytes ?? undefined)
                    : undefined,
                onWriteWaitModeChange: (mode) =>
                  rememberWaitMode(deviceId, mode),
                diagnostic:
                  dialog === "diagnostics"
                    ? {
                        openTarget: {
                          device,
                          session: connectionSession,
                          retry:
                            !isReplay &&
                            !isCapture &&
                            !disabled &&
                            !state.devicesStale &&
                            opening === null &&
                            device
                              ? () => void open(deviceId)
                              : undefined,
                        },
                        receiveEncoding,
                        onApplyEncoding:
                          session && !isReplay && !isCapture
                            ? (value) => {
                                changeViewFormat({
                                  receiveMode: "text",
                                  receiveEncoding: value,
                                });
                                setDialog(null);
                              }
                            : undefined,
                      }
                    : undefined,
                onInspectMetrics: () => showDialog("metrics"),
                onReconnect:
                  !isReplay &&
                  !isCapture &&
                  !disabled &&
                  !state.devicesStale &&
                  opening === null &&
                  session &&
                  state.devices.some(
                    (entry) => entry.deviceId === session.deviceId,
                  )
                    ? () => void open(session.deviceId)
                    : undefined,
                target: isCapture
                  ? undefined
                  : dialog === "parameters" || dialog === "controls"
                    ? connectionTarget
                    : dialog === "sessionTemplates"
                      ? connectionSession?.sessionId === sessionId
                        ? connectionTarget
                        : undefined
                      : target,
                isReplay:
                  isCapture ||
                  (dialog === "parameters" || dialog === "controls"
                    ? !!connectionSession &&
                      replayIds.has(connectionSession.sessionId)
                    : isReplay),
                items,
                sourceItems,
                chartSelection: currentChartLink?.selection,
                onRevealChartSource: (source) =>
                  void beforeReplace().then((allowed) => {
                    if (!allowed) return;
                    setChartLink({ scope: chartScope, reveal: source });
                    setDialog(null);
                  }),
                openError:
                  openError &&
                  (dialog !== "diagnostics" || failure?.deviceId === deviceId)
                    ? failure
                    : undefined,
                onInspectBytes:
                  session && !isReplay && !isCapture
                    ? () => {
                        changeViewFormat({ receiveMode: "hex" });
                        setDialog(null);
                      }
                    : undefined,
              })}
          </>
        )}
      </WorkbenchDialog>
    </section>
  );
}
