import {
  ContractValidationError,
  defaults,
  parseReply,
  parseOperationsSnapshot,
} from "@serial-workbench/contracts";
import type {
  ActionSpec,
  FavoritesSaveParams,
  RebindParams,
  FileReadParams,
  FileMetadataParams,
  FileTransferReceiptsParams,
  ObjectRef,
  Operation,
  Query,
  ReplayReadParams,
  ReplayRecord,
  SerialConfiguration,
  SessionSnapshot,
  Target,
  WorkspaceDocument,
  WorkspaceDocumentResult,
} from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import type { HostConnection } from "@/lib/host-client";
import { abortError, waitForHost } from "@/lib/host-native-transport";
import { createSessionReaders } from "@/lib/host-session-readers";
import { readReplayRecord as readRecord } from "@/lib/host-reader";
import {
  hostConnectDevice,
  chooseFileResource,
  hostApplyDocumentIntent,
} from "@/lib/tauri";
import type { FileResourceRole } from "@/lib/tauri";
import type {
  HostContextValue,
  HostInvocation,
  HostState,
  HostActionCheckInput,
  HostActionAvailability,
} from "./host-context";
function failure(code: string, message: string) {
  return new HostRequestError({ code, message, retryable: false });
}
function asQueryResult(value: unknown) {
  const reply = parseReply({ ok: true, result: value });
  if (!reply.ok || !("kind" in reply.result))
    throw new ContractValidationError();
  return reply.result;
}
const terminalStates = new Set<Operation["state"]>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
]);
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
type HostUserActions = {
  connectDevice: typeof hostConnectDevice;
  chooseFile: typeof chooseFileResource;
  applyDocumentIntent: typeof hostApplyDocumentIntent;
};
function sameTarget(a: Target, b: Target) {
  return (
    a.hostId === b.hostId &&
    a.kind === b.kind &&
    a.id === b.id &&
    a.sessionId === b.sessionId &&
    a.sessionEpoch === b.sessionEpoch
  );
}
export function createHostWorkspace(
  connection: HostConnection,
  userActions: HostUserActions = {
    connectDevice: hostConnectDevice,
    chooseFile: chooseFileResource,
    applyDocumentIntent: hostApplyDocumentIntent,
  },
) {
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const pendingOpens = new Map<string, Promise<SessionSnapshot>>();
  const pendingTrustedConnections = new Map<string, Promise<SessionSnapshot>>();
  const replaySessionsLoading = new Set<string>();
  const projections = new Map<
    string,
    { target: Target; close: () => void; controller: AbortController }
  >();
  let state: HostState = {
    status: "connecting",
    error: null,
    devices: [],
    devicesStale: false,
    catalog: [],
    sessions: [],
    operations: [],
    operationSummaries: [],
    streams: new Map(),
  };
  let refreshPending: Promise<void> | undefined;
  let operationsRefreshing = false;
  let operationIds: string[] | undefined;
  let workspaceSelection = 0;
  let snapshot: HostContextValue;
  type ActionWatcher = {
    inputs: readonly HostActionCheckInput[];
    listener: (values: readonly HostActionAvailability[]) => void;
  };
  const actionWatchers = new Set<ActionWatcher>();
  let checksVersion = 0;
  let checksRunning = false;
  let checksRequested = false;
  let checksTimer: ReturnType<typeof setTimeout> | undefined;
  let checksRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let checksExpiresAt: number | undefined;
  const checksMaxAgeMs = 1000;
  const checksRefreshMs = checksMaxAgeMs / 2;
  const visible = () => typeof document === "undefined" || !document.hidden;
  function clearChecksTimer() {
    clearTimeout(checksTimer);
    clearTimeout(checksRefreshTimer);
    checksTimer = undefined;
    checksRefreshTimer = undefined;
    checksExpiresAt = undefined;
  }
  function unknownActions(watcher: ActionWatcher) {
    watcher.listener(
      watcher.inputs.map((input) => ({
        input,
        result: null,
        error: null,
      })),
    );
  }
  function invalidateActions() {
    checksVersion++;
    clearChecksTimer();
    for (const watcher of actionWatchers) unknownActions(watcher);
    checksRequested =
      actionWatchers.size > 0 && visible() && !lifetime.signal.aborted;
    if (checksRequested) void refreshActionChecks();
  }
  async function refreshActionChecks() {
    if (
      checksRunning ||
      !checksRequested ||
      lifetime.signal.aborted ||
      !visible()
    )
      return;
    checksRunning = true;
    checksRequested = false;
    const version = checksVersion;
    const startedAt = performance.now();
    if (checksExpiresAt === undefined) {
      checksExpiresAt = startedAt + checksMaxAgeMs;
      checksTimer = setTimeout(invalidateActions, checksMaxAgeMs);
    }
    const currentRound = () => {
      if (version !== checksVersion || lifetime.signal.aborted || !visible())
        return false;
      if (checksExpiresAt !== undefined && performance.now() < checksExpiresAt)
        return true;
      invalidateActions();
      return false;
    };
    let succeeded = true;
    try {
      for (const watcher of [...actionWatchers]) {
        const values: HostActionAvailability[] = [];
        for (const input of watcher.inputs) {
          if (!currentRound()) return;
          if (!actionWatchers.has(watcher)) break;
          try {
            values.push({
              input,
              result: await checkAction(input),
              error: null,
            });
          } catch (error) {
            succeeded = false;
            values.push({
              input,
              result: null,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        }
        if (!currentRound()) return;
        if (actionWatchers.has(watcher)) {
          watcher.listener(values);
        }
      }
      // 提前续检不改变旧截止；整轮及时成功后，期限仍从本轮发起时刻计算。
      if (succeeded && currentRound()) {
        clearTimeout(checksTimer);
        checksExpiresAt = startedAt + checksMaxAgeMs;
        checksTimer = setTimeout(
          invalidateActions,
          Math.max(0, checksExpiresAt - performance.now()),
        );
        clearTimeout(checksRefreshTimer);
        checksRefreshTimer = setTimeout(
          () => {
            checksRefreshTimer = undefined;
            if (version !== checksVersion) return;
            checksRequested =
              actionWatchers.size > 0 && visible() && !lifetime.signal.aborted;
            if (checksRequested) void refreshActionChecks();
          },
          Math.max(0, startedAt + checksRefreshMs - performance.now()),
        );
      }
    } finally {
      checksRunning = false;
      if (checksRequested) void refreshActionChecks();
    }
  }
  function watchActions(
    inputs: readonly HostActionCheckInput[],
    listener: ActionWatcher["listener"],
  ) {
    if (lifetime.signal.aborted) throw abortError();
    const count = [...actionWatchers].reduce(
      (sum, watcher) => sum + watcher.inputs.length,
      0,
    );
    if (count + inputs.length > 128)
      throw new RangeError("Too many visible action checks");
    const watcher: ActionWatcher = {
      inputs: structuredClone(inputs),
      listener,
    };
    actionWatchers.add(watcher);
    invalidateActions();
    return () => {
      if (!actionWatchers.delete(watcher)) return;
      invalidateActions();
    };
  }
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", invalidateActions);
  if (typeof window !== "undefined")
    window.addEventListener("focus", invalidateActions);
  const change = (patch: Partial<HostState>) => {
    if (lifetime.signal.aborted) return;
    state = { ...state, ...patch };
    snapshot = { ...actions, state, connection };
    for (const listener of listeners) listener();
  };
  const readers = createSessionReaders(connection, (sessionId, view) => {
    const streams = new Map(state.streams);
    if (view) streams.set(sessionId, view);
    else streams.delete(sessionId);
    change({ streams });
  });
  const report = (error: unknown) => {
    if (error instanceof HostRequestError && error.code === "PERMISSION_DENIED")
      invalidateActions();
    if (!lifetime.signal.aborted)
      change({
        error: error instanceof Error ? error : new Error(String(error)),
      });
  };
  function sessionTarget(session: SessionSnapshot): Target {
    return {
      hostId: connection.attachment.hostId,
      kind: "session",
      id: session.sessionId,
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
    };
  }
  function sessionById(id: string) {
    const session = state.sessions.find((value) => value.sessionId === id);
    if (!session) throw failure("NOT_FOUND", "Session is not available");
    return session;
  }
  function updateSession(session: SessionSnapshot) {
    const previous = state.sessions.find(
      (value) => value.sessionId === session.sessionId,
    );
    if (previous && BigInt(previous.revision) > BigInt(session.revision))
      return;
    if (previous && previous.sessionEpoch !== session.sessionEpoch)
      invalidateActions();
    change({
      sessions: [
        ...state.sessions.filter(
          (value) => value.sessionId !== session.sessionId,
        ),
        session,
      ],
    });
    readers.update(session);
  }
  function updateOperation(operation: Operation) {
    const previous = state.operations.find(
      (value) => value.operationId === operation.operationId,
    );
    if (previous && BigInt(previous.revision) > BigInt(operation.revision))
      return;
    change({
      operations: [
        ...state.operations.filter(
          (value) => value.operationId !== operation.operationId,
        ),
        operation,
      ].slice(-128),
    });
    if (
      operation.actionId === "replay.open" &&
      operation.state === "succeeded" &&
      operation.result?.kind === "opened"
    ) {
      const opened = operation.result.value;
      if (
        !state.sessions.some(
          (session) =>
            session.sessionId === opened.sessionId &&
            session.sessionEpoch === opened.sessionEpoch,
        ) &&
        !replaySessionsLoading.has(opened.sessionId)
      ) {
        replaySessionsLoading.add(opened.sessionId);
        void (async () => {
          const result = await connection.client.query(
            connection.buildQuery("session.get", {
              hostId: connection.attachment.hostId,
              kind: "session",
              id: opened.sessionId,
              sessionId: opened.sessionId,
              sessionEpoch: opened.sessionEpoch,
            }),
            lifetime.signal,
          );
          if (result.kind !== "session") throw new ContractValidationError();
          updateSession(result.value);
          await syncProjections();
        })()
          .catch(report)
          .finally(() => replaySessionsLoading.delete(opened.sessionId));
      }
    }
  }
  async function operationMetadata(value: unknown) {
    // Host orders active operations first, newest first within each group.
    const summaries = parseOperationsSnapshot(value).items.slice(0, 128);
    change({ operationSummaries: summaries });
    operationIds = summaries.map((item) => item.operationId);
    if (operationsRefreshing) return;
    operationsRefreshing = true;
    try {
      while (operationIds && !lifetime.signal.aborted) {
        const ids = operationIds;
        operationIds = undefined;
        // Bound simultaneous lookups and collapse changes arriving during a refresh.
        for (let offset = 0; offset < ids.length; offset += 8) {
          if (lifetime.signal.aborted) return;
          const batch = ids.slice(offset, offset + 8);
          const results = await Promise.allSettled(
            batch.map(async (id) => {
              const result = await connection.client.query(
                connection.buildQuery("operation.get", connection.hostTarget, {
                  operationId: id,
                }),
                lifetime.signal,
              );
              if (result.kind !== "operation")
                throw new ContractValidationError();
              updateOperation(result.value.operation);
            }),
          );
          for (const [index, result] of results.entries()) {
            if (result.status !== "rejected") continue;
            if (
              result.reason instanceof HostRequestError &&
              result.reason.code === "PERMISSION_DENIED"
            ) {
              change({
                operations: state.operations.filter(
                  (operation) => operation.operationId !== batch[index],
                ),
              });
            } else report(result.reason);
          }
        }
      }
    } finally {
      operationsRefreshing = false;
    }
  }
  async function syncProjections() {
    const scopes = (await connection.refreshScopes(lifetime.signal)).filter(
      (scope) =>
        scope.target.kind === "session" ||
        ["host.devices", "host.operations"].includes(scope.scopeId) ||
        scope.scopeId === state.workspace?.scope.scopeId,
    );
    if (lifetime.signal.aborted) return;
    const retained = new Set(scopes.map((scope) => scope.scopeId));
    for (const [id, entry] of projections) {
      const current = scopes.find((scope) => scope.scopeId === id);
      if (
        !retained.has(id) ||
        current?.target.sessionEpoch !== entry.target.sessionEpoch
      ) {
        entry.controller.abort();
        entry.close();
        projections.delete(id);
      }
    }
    for (const scope of scopes) {
      if (projections.has(scope.scopeId)) continue;
      const controller = new AbortController();
      const stop = () => controller.abort();
      lifetime.signal.addEventListener("abort", stop, { once: true });
      controller.signal.addEventListener(
        "abort",
        () => lifetime.signal.removeEventListener("abort", stop),
        { once: true },
      );
      const entry = { target: scope.target, controller, close: () => {} };
      projections.set(scope.scopeId, entry);
      try {
        entry.close = await connection.client.subscribe(
          scope.scopeId,
          (event) => {
            if (controller.signal.aborted || lifetime.signal.aborted) return;
            if (event.type === "error") {
              report(event.error);
              return;
            }
            const payload =
              event.type === "snapshot"
                ? event.snapshot.state
                : event.delta.payload;
            if (scope.target.kind === "session") {
              const parsed = asQueryResult({ kind: "session", value: payload });
              if (parsed.kind === "session") updateSession(parsed.value);
            } else if (scope.target.kind === "workspace") {
              const parsed = asQueryResult({
                kind: "workspace",
                value: payload,
              });
              if (
                parsed.kind === "workspace" &&
                state.workspace?.scope.scopeId === scope.scopeId
              )
                change({ workspace: parsed.value });
            } else if (scope.scopeId === "host.operations")
              void operationMetadata(payload).catch(report);
            else if (scope.scopeId === "host.devices" && event.type === "delta")
              void refresh().catch(report);
          },
          controller.signal,
        );
        if (controller.signal.aborted) entry.close();
      } catch (error) {
        projections.delete(scope.scopeId);
        if (!controller.signal.aborted) {
          controller.abort();
          throw error;
        }
      }
    }
  }
  async function loadWorkspace(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocumentResult> {
    const selection = ++workspaceSelection;
    const result = await connection.client.query(
      connection.buildQuery("workspace.read", {
        hostId: connection.attachment.hostId,
        kind: "workspace",
        id: workspaceId,
      }),
      signal ?? lifetime.signal,
    );
    if (result.kind !== "workspace") throw new ContractValidationError();
    if (
      result.value.scope.target.hostId !== connection.attachment.hostId ||
      result.value.scope.target.kind !== "workspace" ||
      result.value.scope.target.id !== workspaceId
    )
      throw new ContractValidationError("Workspace belongs to another target");
    if (
      selection === workspaceSelection &&
      !signal?.aborted &&
      !lifetime.signal.aborted
    ) {
      change({ workspace: result.value });
      await syncProjections();
    }
    return result.value;
  }
  async function saveWorkspace(
    base: WorkspaceDocumentResult,
    value: WorkspaceDocument,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocumentResult> {
    return saveDocument(
      base,
      "workspace.save",
      {
        kind: "workspaceSave",
        workspaceId: base.scope.target.id,
        expectedRevision: base.document.revision,
        params: { value },
      },
      signal,
    );
  }
  function checkedWorkspace(value: WorkspaceDocumentResult, target: Target) {
    if (!sameTarget(value.scope.target, target))
      throw new ContractValidationError("Workspace belongs to another target");
    return value;
  }
  async function saveDocument(
    base: WorkspaceDocumentResult,
    actionId: string,
    intent: Parameters<typeof hostApplyDocumentIntent>[1],
    signal?: AbortSignal,
  ) {
    const target = base.scope.target;
    if (
      target.hostId !== connection.attachment.hostId ||
      target.kind !== "workspace" ||
      target.sessionId !== undefined ||
      target.sessionEpoch !== undefined
    )
      throw new ContractValidationError("Workspace belongs to another target");
    const waiting = signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    waiting.throwIfAborted();
    const selection = workspaceSelection;
    const accepted = userActions.applyDocumentIntent(
      connection.generation,
      intent,
    );
    // The gesture may complete after its caller stopped waiting. Only refresh UI rights then.
    void accepted
      .finally(() => {
        if (!lifetime.signal.aborted) invalidateActions();
      })
      .catch(() => {});
    const initial = await waitForHost(accepted, waiting);
    waiting.throwIfAborted();
    if (
      initial.actionId !== actionId ||
      initial.executionHostId !== target.hostId ||
      !sameTarget(initial.target, target)
    )
      throw new ContractValidationError(
        "Operation belongs to another workspace target",
      );
    updateOperation(initial);
    const operation = await waitForOperation(initial, waiting);
    waiting.throwIfAborted();
    if (operation.result?.kind !== "workspace")
      throw new ContractValidationError();
    const receipt = checkedWorkspace(operation.result.value, target);
    if (BigInt(receipt.document.revision) <= BigInt(base.document.revision))
      throw new ContractValidationError(
        "Saved workspace revision did not advance",
      );
    if (
      selection === workspaceSelection &&
      state.workspace &&
      sameTarget(state.workspace.scope.target, target) &&
      BigInt(state.workspace.document.revision) <=
        BigInt(receipt.document.revision)
    )
      change({ workspace: receipt });
    invalidateActions();
    return receipt;
  }
  function saveFavorites(
    base: WorkspaceDocumentResult,
    params: FavoritesSaveParams,
    signal?: AbortSignal,
  ) {
    return saveDocument(
      base,
      "favorites.save",
      {
        kind: "favoritesSave",
        workspaceId: base.scope.target.id,
        expectedRevision: base.document.revision,
        params,
      },
      signal,
    );
  }
  function rebindDevice(
    base: WorkspaceDocumentResult,
    params: RebindParams,
    signal?: AbortSignal,
  ) {
    return saveDocument(
      base,
      "device.rebind",
      {
        kind: "deviceRebind",
        workspaceId: base.scope.target.id,
        expectedRevision: base.document.revision,
        params,
      },
      signal,
    );
  }
  async function recentConnections(signal?: AbortSignal) {
    const result = await connection.client.query(
      connection.buildQuery("recent.list", connection.hostTarget),
      signal ?? lifetime.signal,
    );
    if (result.kind !== "recent") throw new ContractValidationError();
    return result.value;
  }
  function workspaceTarget(workspaceId: string): Target {
    return {
      hostId: connection.attachment.hostId,
      kind: "workspace",
      id: workspaceId,
    };
  }
  async function exportWorkspace(workspaceId: string, signal?: AbortSignal) {
    const result = await connection.client.query(
      connection.buildQuery("workspace.export", workspaceTarget(workspaceId)),
      signal ?? lifetime.signal,
    );
    if (result.kind !== "document_json") throw new ContractValidationError();
    return result.value;
  }
  async function previewWorkspaceImport(
    workspaceId: string,
    json: string,
    signal?: AbortSignal,
  ) {
    const result = await connection.client.query(
      connection.buildQuery(
        "workspace.importPreview",
        workspaceTarget(workspaceId),
        { json },
      ),
      signal ?? lifetime.signal,
    );
    if (result.kind !== "workspace_import_preview")
      throw new ContractValidationError();
    return result.value;
  }
  async function checkAction(
    input: HostActionCheckInput,
    signal?: AbortSignal,
  ) {
    const waiting = signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    waiting.throwIfAborted();
    const result = await connection.client.query(
      connection.buildQuery("action.check", input.target, {
        actionId: input.actionId,
        params: input.params,
      }),
      waiting,
    );
    waiting.throwIfAborted();
    if (
      result.kind !== "action_check" ||
      result.value.actionId !== input.actionId ||
      result.value.target.hostId !== connection.attachment.hostId ||
      !sameTarget(result.value.target, input.target)
    )
      throw new ContractValidationError();
    return result.value;
  }
  async function refresh() {
    if (lifetime.signal.aborted) throw abortError();
    if (refreshPending) return refreshPending;
    const pending = (async () => {
      const catalog: ActionSpec[] = [];
      let pageToken: string | undefined;
      do {
        const result = await connection.client.query(
          connection.buildQuery("catalog.list", connection.hostTarget, {
            pageSize: "100",
            ...(pageToken ? { pageToken } : {}),
          }),
          lifetime.signal,
        );
        if (result.kind !== "catalog") throw new ContractValidationError();
        catalog.push(...result.value.items);
        pageToken = result.value.nextPageToken;
      } while (pageToken);
      const devices = await connection.client.query(
        connection.buildQuery("device.list", connection.hostTarget),
        lifetime.signal,
      );
      if (devices.kind !== "devices") throw new ContractValidationError();
      change({
        devices: devices.value.devices,
        devicesStale: devices.value.stale,
        catalog,
      });
      if (!state.workspace) await loadWorkspace("default");
      await syncProjections();
      change({ status: "ready", error: null });
    })();
    refreshPending = pending;
    try {
      await pending;
    } finally {
      if (refreshPending === pending) refreshPending = undefined;
    }
  }
  async function invoke(input: HostInvocation, signal?: AbortSignal) {
    const { actionId, target, params, ...options } = input;
    try {
      const operation = await connection.client.invoke(
        connection.buildCall(actionId, target, params, options),
        signal ?? lifetime.signal,
      );
      updateOperation(operation);
      return operation;
    } catch (error) {
      if (
        error instanceof HostRequestError &&
        error.code === "PERMISSION_DENIED"
      )
        invalidateActions();
      throw error;
    }
  }
  async function rawQuery(query: Query, signal?: AbortSignal) {
    const reply = parseReply(
      await connection.transport.rawRequest(
        { method: "action.query", params: query },
        signal ?? lifetime.signal,
      ),
    );
    if (!reply.ok) throw new HostRequestError(reply.error);
    if (!("kind" in reply.result)) throw new ContractValidationError();
    return reply.result;
  }
  function referenceTarget(reference: ObjectRef): Target {
    return { hostId: reference.hostId, kind: reference.kind, id: reference.id };
  }
  async function metrics(signal?: AbortSignal) {
    const result = await connection.client.query(
      connection.buildQuery("host.metrics", connection.hostTarget),
      signal ?? lifetime.signal,
    );
    if (result.kind !== "host_metrics") throw new ContractValidationError();
    return result.value;
  }
  async function sessionMetrics(target: Target, signal?: AbortSignal) {
    const waiting = signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    waiting.throwIfAborted();
    if (
      target.hostId !== connection.attachment.hostId ||
      target.kind !== "session" ||
      target.id !== target.sessionId ||
      !target.sessionEpoch
    )
      throw new ContractValidationError();
    const result = await connection.client.query(
      connection.buildQuery("session.metrics", target, {}),
      waiting,
    );
    waiting.throwIfAborted();
    if (
      result.kind !== "session_metrics" ||
      result.value.sessionId !== target.id ||
      result.value.sessionEpoch !== target.sessionEpoch ||
      result.value.instanceEpoch !== connection.attachment.instanceEpoch
    )
      throw new ContractValidationError();
    return result.value;
  }
  async function sessionInputs(target: Target, signal?: AbortSignal) {
    const waiting = signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    waiting.throwIfAborted();
    if (
      target.hostId !== connection.attachment.hostId ||
      target.kind !== "session" ||
      target.id !== target.sessionId ||
      !target.sessionEpoch
    )
      throw new ContractValidationError();
    const result = await connection.client.query(
      connection.buildQuery("session.inputs", target, {}),
      waiting,
    );
    waiting.throwIfAborted();
    if (
      result.kind !== "session_inputs" ||
      result.value.sessionId !== target.id ||
      result.value.sessionEpoch !== target.sessionEpoch
    )
      throw new ContractValidationError();
    return result.value;
  }
  async function operationInput(operationId: string, signal?: AbortSignal) {
    const result = await rawQuery(
      connection.buildQuery("operation.input", connection.hostTarget, {
        operationId,
      }),
      signal,
    );
    if (result.kind !== "operation_input") throw new ContractValidationError();
    return result.value;
  }
  function pickFile(
    role: FileResourceRole,
    signal?: AbortSignal,
    selectedSessionId?: string,
  ) {
    const waiting = signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    waiting.throwIfAborted();
    const session =
      role === "captureTarget"
        ? state.sessions.find(
            (value) =>
              value.sessionId === selectedSessionId &&
              value.state === "open" &&
              !value.readOnly,
          )
        : undefined;
    const device = session
      ? state.devices.find(
          (value) =>
            value.deviceId === session.deviceId &&
            value.hostId === connection.attachment.hostId,
        )
      : undefined;
    const pending =
      session && device
        ? userActions.chooseFile(role, connection.generation, {
            deviceName: device.systemName,
            baudRate: session.configuration.baudRate,
          })
        : userActions.chooseFile(role, connection.generation);
    void pending
      .finally(() => {
        if (!lifetime.signal.aborted) invalidateActions();
      })
      .catch(() => {});
    return waitForHost(pending, waiting);
  }
  function trustedConnect(
    deviceId: string,
    signal?: AbortSignal,
    configuration: SerialConfiguration = defaults.serialConfiguration,
  ): Promise<SessionSnapshot> {
    const waiting = signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    if (waiting.aborted) return Promise.reject(abortError());
    let pending = pendingTrustedConnections.get(deviceId);
    if (!pending) {
      pending = (async () => {
        const session = await userActions
          .connectDevice(connection.generation, deviceId, { configuration })
          .finally(() => {
            if (!lifetime.signal.aborted) invalidateActions();
          });
        if (lifetime.signal.aborted) throw abortError();
        updateSession(session);
        // The explicit native action changed this actor's permissions. Read the new catalog/scopes.
        await refreshPending;
        await refresh();
        return session;
      })();
      pendingTrustedConnections.set(deviceId, pending);
      void pending
        .finally(() => pendingTrustedConnections.delete(deviceId))
        .catch(() => {});
    }
    return waitForHost(pending, waiting);
  }
  async function fileMetadata(reference: ObjectRef, signal?: AbortSignal) {
    const waiting = signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    waiting.throwIfAborted();
    if (
      reference.hostId !== connection.attachment.hostId ||
      reference.kind !== "file"
    )
      throw new ContractValidationError();
    const params: FileMetadataParams = { fileRef: reference };
    const result = await connection.client.query(
      connection.buildQuery(
        "file.metadata",
        referenceTarget(reference),
        params,
      ),
      waiting,
    );
    waiting.throwIfAborted();
    if (
      result.kind !== "file_metadata" ||
      !sameTarget(result.value.fileRef, reference) ||
      result.value.fileRef.revision !== reference.revision
    )
      throw new ContractValidationError();
    return result.value;
  }
  async function readCaptureTail(reference: ObjectRef, signal?: AbortSignal) {
    if (reference.hostId !== connection.attachment.hostId)
      throw new ContractValidationError();
    const result = await rawQuery(
      connection.buildQuery("capture.tail", referenceTarget(reference), {
        captureRef: reference,
        maxRecords: "100",
        maxBytes: "262144",
      }),
      signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
    );
    if (
      result.kind !== "capture_tail" ||
      !sameTarget(result.value.captureRef, reference) ||
      (reference.revision !== undefined
        ? result.value.captureRef.revision !== reference.revision
        : reference.kind !== "capture" &&
          result.value.captureRef.revision !== undefined)
    )
      throw new ContractValidationError();
    return result.value;
  }
  async function captureStatus(reference: ObjectRef, signal?: AbortSignal) {
    const result = await connection.client.query(
      connection.buildQuery("capture.status", referenceTarget(reference), {
        captureRef: reference,
      }),
      signal ?? lifetime.signal,
    );
    if (result.kind !== "capture_status") throw new ContractValidationError();
    return result.value;
  }
  async function readFile(params: FileReadParams, signal?: AbortSignal) {
    const result = await rawQuery(
      connection.buildQuery(
        "file.read",
        referenceTarget(params.fileRef),
        params,
      ),
      signal,
    );
    if (result.kind !== "file_read") throw new ContractValidationError();
    return result.value;
  }
  function readReplayRecord(
    reference: Extract<ReplayRecord, { kind: "reference" }>,
    signal?: AbortSignal,
  ) {
    return readRecord(
      reference,
      readFile,
      signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
    );
  }
  async function readFileReceipts(
    params: FileTransferReceiptsParams,
    signal?: AbortSignal,
  ) {
    const result = await rawQuery(
      connection.buildQuery(
        "transfer.receiptsRead",
        referenceTarget(params.receiptsRef),
        params,
      ),
      signal,
    );
    if (result.kind !== "file_transfer_receipts")
      throw new ContractValidationError();
    return result.value;
  }
  async function readReplay(params: ReplayReadParams, signal?: AbortSignal) {
    const result = await rawQuery(
      connection.buildQuery(
        "replay.read",
        {
          hostId: connection.attachment.hostId,
          kind: "session",
          id: params.sessionId,
          sessionId: params.sessionId,
          sessionEpoch: params.sessionEpoch,
        },
        params,
      ),
      signal,
    );
    if (result.kind !== "replay_read") throw new ContractValidationError();
    return result.value;
  }
  async function waitForOperation(operation: Operation, signal?: AbortSignal) {
    const waiting = signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    waiting.throwIfAborted();
    const initial = operation;
    if (
      operation.executionHostId !== connection.attachment.hostId ||
      operation.target.hostId !== connection.attachment.hostId
    )
      throw new ContractValidationError("Operation belongs to another Host");
    while (!terminalStates.has(operation.state)) {
      await pause(50, waiting);
      const result = await connection.client.query(
        connection.buildQuery("operation.get", connection.hostTarget, {
          operationId: operation.operationId,
        }),
        waiting,
      );
      waiting.throwIfAborted();
      if (
        result.kind !== "operation" ||
        result.value.operation.operationId !== initial.operationId ||
        result.value.operation.actionId !== initial.actionId ||
        result.value.operation.executionHostId !== initial.executionHostId ||
        !sameTarget(result.value.operation.target, initial.target)
      )
        throw new ContractValidationError();
      operation = result.value.operation;
      updateOperation(operation);
    }
    if (operation.error) throw new HostRequestError(operation.error);
    if (operation.state !== "succeeded")
      throw failure("OPERATION_ABORTED", "Operation did not succeed");
    return operation;
  }
  function open(
    deviceId: string,
    signal?: AbortSignal,
    configuration: SerialConfiguration = defaults.serialConfiguration,
  ): Promise<SessionSnapshot> {
    if (signal?.aborted || lifetime.signal.aborted)
      return Promise.reject(abortError());
    const current = state.sessions.find(
      (session) => session.deviceId === deviceId && session.state === "open",
    );
    if (current) return Promise.resolve(current);
    let pending = pendingOpens.get(deviceId);
    if (!pending) {
      pending = (async () => {
        const target: Target = {
          hostId: connection.attachment.hostId,
          kind: "device",
          id: deviceId,
        };
        const operation = await waitForOperation(
          await invoke({
            actionId: "device.open",
            target,
            params: { configuration: { ...configuration } },
            executionMode: "interactive",
          }),
        );
        if (operation.result?.kind !== "opened")
          throw new ContractValidationError();
        const opened = operation.result.value;
        const sessionTarget: Target = {
          hostId: target.hostId,
          kind: "session",
          id: opened.sessionId,
          sessionId: opened.sessionId,
          sessionEpoch: opened.sessionEpoch,
        };
        const result = await connection.client.query(
          connection.buildQuery("session.get", sessionTarget),
          lifetime.signal,
        );
        if (result.kind !== "session") throw new ContractValidationError();
        updateSession(result.value);
        await syncProjections();
        return result.value;
      })();
      pendingOpens.set(deviceId, pending);
      void pending.finally(() => pendingOpens.delete(deviceId)).catch(() => {});
    }
    return waitForHost(pending, signal);
  }
  async function send(
    sessionId: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ) {
    const session = sessionById(sessionId);
    if (session.readOnly)
      throw failure("PERMISSION_DENIED", "Session is read only");
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return invoke(
      {
        actionId: "session.tx",
        target: sessionTarget(session),
        params: {
          bytesBase64: btoa(binary),
          writeWaitMs: session.configuration.writeWaitMs,
        },
        executionMode: "interactive",
      },
      signal,
    );
  }
  async function takeover(sessionId: string, signal?: AbortSignal) {
    const session = sessionById(sessionId);
    if (session.readOnly)
      throw failure("PERMISSION_DENIED", "Session is read only");
    return invoke(
      {
        actionId: "session.takeover",
        target: sessionTarget(session),
        params: { actorId: connection.attachment.actorId, reason: "user" },
        executionMode: "interactive",
      },
      signal,
    );
  }
  function watchSession(sessionId: string, listener: () => void): () => void {
    return readers.watch(sessionById(sessionId), listener);
  }
  const actions = {
    refresh,
    metrics,
    sessionMetrics,
    sessionInputs,
    operationInput,
    pickFile,
    trustedConnect,
    readFile,
    fileMetadata,
    readReplayRecord,
    captureStatus,
    readCaptureTail,
    readFileReceipts,
    readReplay,
    loadWorkspace,
    saveWorkspace,
    saveFavorites,
    rebindDevice,
    recentConnections,
    exportWorkspace,
    previewWorkspaceImport,
    waitForOperation,
    checkAction,
    watchActions,
    open,
    send,
    takeover,
    invoke,
    watchSession,
  };
  snapshot = { state, ...actions, connection };
  return {
    ...actions,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      lifetime.abort();
      clearChecksTimer();
      actionWatchers.clear();
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", invalidateActions);
      if (typeof window !== "undefined")
        window.removeEventListener("focus", invalidateActions);
      for (const projection of projections.values()) projection.close();
      readers.dispose();
      projections.clear();

      listeners.clear();
      connection.dispose();
    },
  };
}
