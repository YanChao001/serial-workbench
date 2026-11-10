import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
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
  StreamItem,
} from "@serial-workbench/contracts";
import type {
  HostActionAvailability,
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { nativeErrorCode } from "@/lib/native-error";
import type { UserLogInput, UserLogModule } from "@/lib/user-log";
import type { ConnectionDefaults } from "@/lib/client-connection-defaults";
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
import { StreamView } from "./stream-view";
import { SendPanel } from "./send-panel";
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
  onInspectMetrics: () => void;
  onReconnect?: () => void;
  beforeReplace: () => Promise<boolean>;
  target?: Target;
  isReplay: boolean;
  items: readonly import("@serial-workbench/contracts").StreamItem[];
  openError?: WorkbenchFailure;
  onInspectBytes: () => void;
};
export type WorkspaceLayoutProps = {
  connectionDefaults?: Readonly<ConnectionDefaults>;
  connectionDefaultsLoading?: boolean;
  onRememberConnection?: (
    hostId: string,
    deviceId: string,
    value: SerialConfiguration,
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
    | "newData"
    | "clearView"
    | "customLineEnding"
    | "customLineEndingHex"
    | "saveCurrentLayout"
    | "deviceListStale",
    string
  >;
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
  drafts: Record<string, string>,
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
  host,
  labels,
  initialWorkspace,
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
  const localDraftTabId = useRef<string | undefined>(undefined);
  const [{ tabs, selected }, setViews] = useState<{
    tabs: SessionTab[];
    selected?: string;
  }>(() => {
    const restored = workspaceTabs(initialWorkspace);
    if (initialWorkspace?.captures.length && initialDrafts.unconnected) {
      let localId = "unconnected";
      while (restored.some((tab) => tab.id === localId))
        localId = "_" + localId;
      localDraftTabId.current = localId;
      return { tabs: [{ id: localId }, ...restored], selected: localId };
    }
    return { tabs: restored, selected: restored[0]?.id };
  });
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    restoreViewDraftIdentity(
      { ...initialDrafts },
      initialWorkspace,
      initialDrafts.unconnected,
    ),
  );
  const [savedDrafts, setSavedDrafts] = useState<Record<string, string>>(() =>
    restoreViewDraftIdentity(
      { ...initialDrafts },
      initialWorkspace,
      initialDrafts.unconnected,
    ),
  );
  const [opening, setOpening] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const choosingResource = useRef(false);
  const [error, setError] = useState<Omit<WorkbenchFailure, "message">>();
  const lastFailure = useRef(0);
  const failure = error
    ? {
        ...error,
        message: `${formatError?.({ code: error.code }) ?? labels.unavailable}${error.code ? ` (${error.code})` : ""}`,
      }
    : undefined;
  const [openError, setOpenError] = useState(false);
  const [following, setFollowing] = useState(true);
  const [connectionConfigurations, setConnectionConfigurations] = useState<
    Readonly<Record<string, SerialConfiguration>>
  >({});
  const configurationEdits = useRef(new Map<string, number>());
  const [deviceChoice, setDeviceChoice] = useState("");
  const [dialog, setDialog] = useState<
    WorkbenchTool | "capture" | "activity" | "tasks" | "metrics" | "logs" | null
  >(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const [clearThrough, setClearThrough] = useState<
    ReadonlyMap<string, StreamItem | undefined>
  >(new Map());
  const [viewModes, setViewModes] = useState<WindowViewModes>({});
  const [savingLayout, setSavingLayout] = useState(false);
  const [unboundSendMode, setUnboundSendMode] = useState<"text" | "hex">();
  const [sendBytes, setSendBytes] = useState<Uint8Array | null>(null);
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
    const before = previousWorkspace.current;
    previousWorkspace.current = {
      key: workspaceKey,
      document: initialWorkspace,
    };
    if (before.key !== workspaceKey) {
      focusRevision.current++;
      setFollowing(false);
      setViews((current) => {
        const restored = workspaceTabs(initialWorkspace);
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
    }
  }, [
    workspaceKey,
    initialWorkspace,
    state.status,
    drafts,
    initialDrafts.unconnected,
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
            state.sessions.some((session) => session.sessionId === id),
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
    (id: string, deviceId?: string) => {
      const device = state.devices.find(
        (value) =>
          value.deviceId ===
          (deviceId ??
            state.sessions.find((value) => value.sessionId === id)?.deviceId),
      );
      const bindingIds =
        initialWorkspace?.bindings
          .filter(
            (binding) =>
              binding.deviceId === device?.deviceId &&
              binding.hostId === device?.hostId,
          )
          .map((binding) => binding.bindingId) ?? [];
      const matchingTab = tabs.find(
        (tab) =>
          tab.sessionId === id ||
          bindingIds.includes(tab.view?.bindingId ?? ""),
      );
      const draftKey =
        matchingTab?.view?.id === "unconnected"
          ? UNCONNECTED_VIEW_DRAFT
          : (matchingTab?.id ?? "session-" + id);
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
        const existing = current.tabs.find((tab) => tab.sessionId === id);
        if (existing) {
          return current.selected === existing.id
            ? current
            : { ...current, selected: existing.id };
        }
        const device = state.devices.find(
          (value) =>
            value.deviceId ===
            (deviceId ??
              state.sessions.find((value) => value.sessionId === id)?.deviceId),
        );
        const bindings =
          initialWorkspace?.bindings.filter(
            (binding) =>
              binding.deviceId === device?.deviceId &&
              binding.hostId === device?.hostId,
          ) ?? [];
        const restored = current.tabs.find((tab) =>
          bindings.some((binding) => binding.bindingId === tab.view?.bindingId),
        );
        if (restored)
          return {
            selected: restored.id,
            tabs: current.tabs.map((tab) =>
              bindings.some(
                (binding) => binding.bindingId === tab.view?.bindingId,
              )
                ? { ...tab, sessionId: id }
                : tab,
            ),
          };
        const tab = { id: `session-${id}`, sessionId: id };
        return { tabs: [...current.tabs, tab], selected: tab.id };
      });
    },
    [initialWorkspace, state.devices, state.sessions, tabs],
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
    const snapshot = { ...drafts };
    await onSaveDrafts(snapshot, signal);
    if (!signal?.aborted) setSavedDrafts(snapshot);
  };
  const dirty = JSON.stringify(drafts) !== JSON.stringify(savedDrafts);
  useUnsavedWork({
    id: "workbench-drafts",
    label: labels.draft,
    dirty,
    save: saveDrafts,
    discard: () => setDrafts(savedDrafts),
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
    setConnectionConfigurations((current) => ({ ...current, [key]: value }));
    const device = state.devices.find((item) => item.deviceId === id);
    if (device) onRememberConnection?.(device.hostId, id, value);
  }
  function requestedConfiguration(id: string): SerialConfiguration {
    const device = state.devices.find((value) => value.deviceId === id);
    const bindings =
      initialWorkspace?.bindings.filter(
        (binding) =>
          binding.deviceId === id && binding.hostId === device?.hostId,
      ) ?? [];
    const binding =
      bindings.find(
        (value) => value.bindingId === selectedTab?.view?.bindingId,
      ) ?? bindings[0];
    return (
      connectionConfigurations[configurationKeyFor(id)] ??
      connectionDefaults?.[configurationKeyFor(id)] ??
      binding?.configuration ??
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
    // 已存在的视图可先展示元数据；内容仍由 Host 验权，下面的显式授权不能跳过。
    if (existing && !existing.readOnly)
      selectSession(existing.sessionId, existing.deviceId);
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
        selectSession(opened.sessionId, opened.deviceId);
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
  const deviceId =
    deviceChoice ||
    state.devices.find((device) => device.deviceId === session?.deviceId)
      ?.deviceId ||
    state.devices[0]?.deviceId ||
    "";
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
    if (target && currentWriteWaitMs !== undefined)
      values.push(
        {
          actionId: "session.tx",
          target,
          params: {
            bytesBase64: btoa(
              Array.from(sendBytes ?? [], (byte) =>
                String.fromCharCode(byte),
              ).join(""),
            ),
            writeWaitMs: currentWriteWaitMs,
          },
        },
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
    if (connectionCloseInput) values.push(connectionCloseInput);
    return values;
  }, [target, currentWriteWaitMs, sendBytes, actorId, connectionCloseInput]);
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
          JSON.stringify(value.input) === JSON.stringify(input) &&
          value.result?.allowed === true &&
          value.error === null,
      )
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
            JSON.stringify(value.input) ===
              JSON.stringify(connectionCloseInput) &&
            (value.result?.allowed === false ||
              nativeErrorCode(value.error) === "PERMISSION_DENIED"),
        )));
  const sendAllowed = sendBytes !== null && allowed("session.tx") && !isReplay;
  const marker = clearThrough.get(selected ?? "");
  const markerKey = (item: StreamItem) =>
    item.kind === "source"
      ? JSON.stringify([
          item.event.hostId,
          item.event.instanceEpoch,
          item.event.sessionId,
          item.event.sessionEpoch,
          item.event.eventSeq,
        ])
      : JSON.stringify(item);
  const markerIndex = marker
    ? (stream?.items.findIndex(
        (item) => markerKey(item) === markerKey(marker),
      ) ?? -1)
    : -1;
  const items = stream?.items.slice(markerIndex + 1) ?? [];
  const changeMode = (kind: "receiveMode" | "sendMode", mode: "text" | "hex") =>
    setViewModes((current) => ({
      ...current,
      [selected ?? "unconnected"]: {
        ...current[selected ?? "unconnected"],
        [kind]: mode,
      },
    }));
  async function saveWindowLayout() {
    if (!initialWorkspace || !onSaveWindowLayout || savingLayout) return;
    setSavingLayout(true);
    const aborted = await act((signal) =>
      onSaveWindowLayout(
        snapshotWindowLayout(
          {
            ...initialWorkspace,
            captures: tabs.flatMap((tab) =>
              tab.captureRef ? [tab.captureRef] : [],
            ),
          },
          tabs.filter((tab) => !tab.captureRef),
          state.sessions,
          state.devices,
          terminalSettings ?? defaults.settings.terminal,
          viewModes,
          viewColor,
        ),
        signal,
      ),
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
        devices={state.devices}
        deviceId={deviceId}
        device={device}
        session={connectionSession}
        hasSessionView={tabs.some(
          (tab) => tab.sessionId === connectionSession?.sessionId,
        )}
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
                const tab = { id: `view-${crypto.randomUUID()}`, sessionId };
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
          allowed("session.close", connectionCloseInput) &&
          !!onCloseSession &&
          connectionSession?.state !== "closed"
        }
        canRestoreAccess={canRestoreAccess}
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
        onDeviceChange={setDeviceChoice}
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
            {openError ? ` — ${labels.connectionHelp}` : ""}
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
            onReceiveModeChange={(mode) => changeMode("receiveMode", mode)}
            initialMode={selectedTab?.view?.receiveMode}
            terminalSettings={terminalSettings}
            presentationLabels={presentationLabels}
            labels={labels}
            error={stream?.error}
            trimmed={stream?.trimmed}
            onOpenCapture={() => showDialog("capture")}
            onOpenActivity={() => showDialog("activity")}
            onClearView={() =>
              setClearThrough((current) =>
                new Map(current).set(selected ?? "", stream?.items.at(-1)),
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
                    newData: toolLabels.newData,
                    clearView: toolLabels.clearView,
                  }
                : undefined
            }
          />
        )}
      </div>
      <SendPanel
        formatError={formatError}
        deviceName={
          state.devices.find((value) => value.deviceId === session?.deviceId)
            ?.systemName
        }
        readOnly={isCapture}
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
            : changeMode("sendMode", mode)
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
        onPreviewChange={setSendBytes}
        draft={drafts[draftKey] ?? ""}
        onDraftChange={(value) =>
          setDrafts((current) => ({
            ...current,
            [draftKey]: value,
          }))
        }
        labels={labels}
        operations={state.operations}
        onSend={async (bytes, signal) => {
          if (isCapture || !session || !target)
            throw new Error(labels.unavailable);
          const checked = await host.checkAction(
            {
              actionId: "session.tx",
              target,
              params: {
                bytesBase64: btoa(
                  Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
                    "",
                  ),
                ),
                writeWaitMs: session.configuration.writeWaitMs,
              },
            },
            signal,
          );
          if (!checked.allowed) throw new Error("PERMISSION_DENIED");
          return host.send(session.sessionId, bytes, signal);
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
                  : dialog === "parameters"
                    ? connectionSession
                    : session,
                beforeReplace,
                configuration: connectionConfiguration,
                configurationKey: configurationKeyFor(deviceId),
                configurationDisabled: !device || disabled,
                onConfigurationChange: (value) =>
                  rememberConfiguration(deviceId, value),
                onInspectMetrics: () => showDialog("metrics"),
                onReconnect:
                  !isReplay && !isCapture && !disabled && (session || deviceId)
                    ? () => void open(session?.deviceId ?? deviceId)
                    : undefined,
                target: isCapture
                  ? undefined
                  : dialog === "parameters"
                    ? connectionTarget
                    : target,
                isReplay:
                  isCapture ||
                  (dialog === "parameters"
                    ? !!connectionSession &&
                      replayIds.has(connectionSession.sessionId)
                    : isReplay),
                items,
                openError: openError ? failure : undefined,
                onInspectBytes: () => {
                  changeMode("receiveMode", "hex");
                  setDialog(null);
                },
              })}
          </>
        )}
      </WorkbenchDialog>
    </section>
  );
}
