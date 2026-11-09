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
import { Button } from "@/components/ui/button";
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
  onConfigurationChange: (value: SerialConfiguration) => void;
  onInspectMetrics: () => void;
  onReconnect?: () => void;
  beforeReplace: () => Promise<boolean>;
  target?: Target;
  isReplay: boolean;
  items: readonly import("@serial-workbench/contracts").StreamItem[];
  openError?: string;
  onInspectBytes: () => void;
};
export type WorkspaceLayoutProps = {
  connectionStatus?: ReactNode;
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
  formatError,
  unboundDraftMessage,
}: WorkspaceLayoutProps) {
  const { state, watchSession, watchActions } = host;
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
  const [error, setError] = useState<string>();
  const [openError, setOpenError] = useState(false);
  const [following, setFollowing] = useState(true);
  const [connectionConfigurations, setConnectionConfigurations] = useState<
    Readonly<Record<string, SerialConfiguration>>
  >({});
  const [deviceChoice, setDeviceChoice] = useState("");
  const [dialog, setDialog] = useState<
    WorkbenchTool | "capture" | "activity" | "tasks" | "metrics" | null
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
    return JSON.stringify([device?.hostId, id]);
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
      binding?.configuration ??
      state.sessions.find((value) => value.deviceId === id)?.configuration ??
      defaults.serialConfiguration
    );
  }
  function actionError(reason: unknown) {
    const code =
      typeof reason === "object" &&
      reason !== null &&
      "code" in reason &&
      typeof reason.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(reason.code)
        ? reason.code
        : undefined;
    const message = formatError?.({ code }) ?? labels.unavailable;
    return code ? `${message} (${code})` : message;
  }
  async function open(deviceId: string) {
    focusRevision.current++;
    setFollowing(false);
    const existing = state.sessions.find(
      (value) => value.deviceId === deviceId && value.state === "open",
    );
    if (existing && !existing.readOnly) {
      selectSession(existing.sessionId, existing.deviceId);
      return;
    }
    if (opening !== null || state.status !== "ready") return;
    const revision = focusRevision.current;
    const controller = new AbortController();
    pending.current.add(controller);
    setOpening(deviceId);
    setError(undefined);
    setOpenError(true);
    try {
      const opened = await (host.trustedConnect ?? host.open)(
        deviceId,
        controller.signal,
        requestedConfiguration(deviceId),
      );
      if (!controller.signal.aborted && revision === focusRevision.current)
        selectSession(opened.sessionId, opened.deviceId);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setOpenError(true);
        setError(actionError(reason));
      }
    } finally {
      pending.current.delete(controller);
      if (!controller.signal.aborted) setOpening(null);
    }
  }
  async function act(action: (signal: AbortSignal) => Promise<unknown>) {
    const controller = new AbortController();
    pending.current.add(controller);
    try {
      await action(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setOpenError(false);
        setError(actionError(reason));
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
  const disabled = state.status !== "ready";
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
  const connectionTarget = useMemo<Target | undefined>(
    () =>
      connectionSession && device
        ? {
            hostId: device.hostId,
            kind: "session",
            id: connectionSession.sessionId,
            sessionId: connectionSession.sessionId,
            sessionEpoch: connectionSession.sessionEpoch,
          }
        : undefined,
    [connectionSession, device],
  );
  const connectionCloseInput = useMemo<HostActionCheckInput | undefined>(
    () =>
      connectionTarget
        ? { actionId: "session.close", target: connectionTarget, params: {} }
        : undefined,
    [connectionTarget],
  );
  const target = useMemo<Target | undefined>(() => {
    const hostId =
      state.devices.find((value) => value.deviceId === session?.deviceId)
        ?.hostId ?? host.connection?.attachment.hostId;
    return session && hostId
      ? {
          hostId,
          kind: "session",
          id: session.sessionId,
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
        }
      : undefined;
  }, [session, state.devices, host.connection]);
  const inputs = useMemo<HostActionCheckInput[]>((): HostActionCheckInput[] => {
    const values: HostActionCheckInput[] = [];
    if (target && session)
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
            writeWaitMs: session.configuration.writeWaitMs,
          },
        },
        { actionId: "session.close", target, params: {} },
        {
          actionId: "session.takeover",
          target,
          params: {
            actorId: host.connection?.attachment.actorId ?? "",
            reason: "user",
          },
        },
      );
    if (connectionCloseInput) values.push(connectionCloseInput);
    return values;
  }, [target, session, sendBytes, host.connection, connectionCloseInput]);
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
    void act((signal) => onCloseSession(session.sessionId, signal));
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
        labels={labels}
        toolLabels={toolLabels}
        workspaceName={initialWorkspace?.name ?? labels.title}
        devices={state.devices}
        deviceId={deviceId}
        device={device}
        session={
          connectionSession &&
          tabs.some((tab) => tab.sessionId === connectionSession.sessionId)
            ? connectionSession
            : undefined
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
          void act((signal) =>
            onCloseSession(connectionSession.sessionId, signal),
          )
        }
        onSave={() => void saveWindowLayout()}
        onRefresh={() => void act(() => host.refresh())}
        onTakeover={takeover}
        onReplay={() => {
          if (onOpenReplay) {
            setFollowing(true);
            void choose(onOpenReplay);
          }
        }}
      />

      {connectionStatus ??
        (state.error && (
          <p className="workbench-error" role="alert">
            {labels.unavailable}
          </p>
        ))}
      {hasUnboundDraft && !isCapture && (
        <p className="px-3 py-1 text-sm text-muted-foreground" role="status">
          {unboundDraftMessage ?? labels.bindingUnavailable}
        </p>
      )}
      {error && (
        <p className="workbench-error" role="alert">
          {error}
          {openError ? ` — ${labels.connectionHelp}` : ""}
        </p>
      )}
      <SessionTabs
        tabs={tabs}
        selected={selected}
        canDuplicate={!disabled && !isCapture && !!session}
        labels={labels}
        onClose={closeView}
        name={(tab) =>
          (tab.captureRef
            ? `${labels.captureTail} ${tabs.filter((value) => value.captureRef).findIndex((value) => value.id === tab.id) + 1} · ${labels.readOnly}`
            : undefined) ??
          (tab.id === localDraftTabId.current && !tab.view && !tab.sessionId
            ? labels.draft
            : undefined) ??
          tab.view?.name ??
          state.devices.find(
            (device) =>
              device.deviceId ===
              state.sessions.find((value) => value.sessionId === tab.sessionId)
                ?.deviceId,
          )?.systemName ??
          state.sessions.find((value) => value.sessionId === tab.sessionId)
            ?.deviceId ??
          tab.id
        }
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
      {!isCapture && (
        <div className="workbench-stream-footer">
          <span>
            {isCapture
              ? labels.readOnly
              : session
                ? `${labels.status}: ${session.state}${session.readOnly || isReplay ? ` · ${labels.readOnly}` : ""}`
                : labels.noSession}
          </span>
          {!state.devices.length && <span>{labels.noDevices}</span>}
          {state.devicesStale && (
            <span role="status">
              {toolLabels?.deviceListStale ?? labels.unavailable}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!dirty || !onSaveDrafts}
            onClick={() => void act((signal) => saveDrafts(signal))}
          >
            {labels.saveDrafts}
          </Button>
        </div>
      )}
      <SendPanel
        readOnly={isCapture}
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
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={
                        hasUnboundDraft
                          ? `${labels.unconnectedDraft} · ${toolLabels?.saveCurrentLayout ?? labels.saveDrafts} · ${labels.expand}`
                          : `${labels.unconnectedDraft} · ${labels.expand}`
                      }
                      title={
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
                      {hasUnboundDraft
                        ? (toolLabels?.saveCurrentLayout ?? labels.saveDrafts)
                        : labels.expand}
                    </Button>
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
              <Button
                size="xs"
                variant="ghost"
                disabled={!dirty || !onSaveDrafts}
                onClick={() => void act((signal) => saveDrafts(signal))}
              >
                {labels.saveDrafts}
              </Button>
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
              labels[dialog as "capture" | "activity" | "tasks" | "metrics"])
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
            {dialog &&
              !["capture", "tasks", "metrics", "activity"].includes(dialog) &&
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
                onConfigurationChange: (value) =>
                  setConnectionConfigurations((current) => ({
                    ...current,
                    [configurationKeyFor(deviceId)]: value,
                  })),
                onInspectMetrics: () => showDialog("metrics"),
                onReconnect:
                  session && !isReplay && !disabled
                    ? () => void open(session.deviceId)
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
                openError: openError ? error : undefined,
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
