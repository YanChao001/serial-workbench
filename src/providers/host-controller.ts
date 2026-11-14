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
import { confirmProjectionHost, HostProjectionError } from "@/lib/host-client";
import { abortError, waitForHost } from "@/lib/host-native-transport";
import { reportClientError } from "@/lib/report-error";
import { createSessionReaders } from "@/lib/host-session-readers";
import { createHostActionObserver } from "./host-action-observer";
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
  let projectionsPending: Promise<void> | undefined;
  let projectionsRequested = false;
  let projectionEpochError: HostProjectionError | undefined;
  let projectionFailures = 0;
  const failedProjectionScopes = new Set<string>();
  let state: HostState = {
    status: "connecting",
    error: null,
    devices: [],
    devicesStale: false,
    catalog: [],
    sessions: [],
    operations: [],
    operationSummaries: [],
    operationSummariesReady: false,
    streams: new Map(),
  };
  let refreshPending: Promise<void> | undefined;
  let refreshEnumerating = false;
  let enumerationPending: Promise<void> | undefined;
  let operationsRefreshing = false;
  let operationRefresh:
    { summaries: HostState["operationSummaries"]; all: boolean } | undefined;
  const shouldRestartOperations = (all: boolean) =>
    operationRefresh !== undefined && (!all || operationRefresh.all);
  let workspaceSelection = 0;
  let snapshot: HostContextValue;
  let streamNotification: ReturnType<typeof setTimeout> | undefined;
  const actionObserver = createHostActionObserver(checkAction, lifetime.signal);
  const watchActions = actionObserver.watch;
  const invalidateActions = actionObserver.invalidate;
  const notify = () => {
    clearTimeout(streamNotification);
    streamNotification = undefined;
    if (!lifetime.signal.aborted) for (const listener of listeners) listener();
  };
  const change = (
    patch: Partial<HostState>,
    deferStreamNotification = false,
  ) => {
    if (lifetime.signal.aborted) return;
    state = { ...state, ...patch };
    snapshot = { ...actions, state, connection };
    // 原始快照和 ACK 即时推进；小读块只合并界面通知，避免每块重渲染整个工作台。
    if (deferStreamNotification) {
      streamNotification ??= setTimeout(notify, 16);
    } else notify();
  };
  const readers = createSessionReaders(
    connection,
    (sessionId, view) => {
      const streams = new Map(state.streams);
      if (view) streams.set(sessionId, view);
      else streams.delete(sessionId);
      change({ streams }, view !== undefined && view.error === null);
    },
    (session) => pendingTrustedConnections.get(session.deviceId),
    updateSession,
  );
  const report = (error: unknown) => {
    reportClientError(
      error instanceof HostProjectionError ? error.cause : error,
      "Host workspace",
    );
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
    // 查询仍逐次验权；同版本内容未变则保留引用。读取可清理 error.details，不能只比较版本。
    if (previous && BigInt(previous.revision) > BigInt(operation.revision))
      return;
    if (
      !previous ||
      previous.revision !== operation.revision ||
      JSON.stringify(previous) !== JSON.stringify(operation)
    ) {
      change({
        operations: [
          ...state.operations.filter(
            (value) => value.operationId !== operation.operationId,
          ),
          operation,
        ].slice(-128),
      });
    }
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
  async function operationMetadata(value: unknown, freshSnapshot: boolean) {
    // Host orders active operations first, newest first within each group.
    const summaries = parseOperationsSnapshot(value).items.slice(0, 128);
    // 设备先就绪；首份有效操作投影到达后，通知才能建立历史基线。
    change({ operationSummaries: summaries, operationSummariesReady: true });
    operationRefresh = {
      summaries,
      all: freshSnapshot || operationRefresh?.all === true,
    };
    if (operationsRefreshing) return;
    operationsRefreshing = true;
    try {
      while (operationRefresh && !lifetime.signal.aborted) {
        const refresh = operationRefresh;
        operationRefresh = undefined;
        const details = new Map(
          state.operations.map((value) => [value.operationId, value]),
        );
        const ids = refresh.summaries
          .filter((summary) => {
            const known = details.get(summary.operationId);
            return (
              refresh.all ||
              !known ||
              known.executionHostId !== summary.executionHostId ||
              BigInt(known.revision) < BigInt(summary.revision)
            );
          })
          .map((summary) => summary.operationId);
        // Bound simultaneous lookups and collapse changes arriving during a refresh.
        for (let offset = 0; offset < ids.length; offset += 8) {
          if (lifetime.signal.aborted) return;
          // 新授权快照必须全量复核；普通增量不能中途取消这一轮脱敏读取。
          // 其余在途轮次按最新投影合并，已开始的读取仍实际结束后再切换。
          if (shouldRestartOperations(refresh.all)) break;
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
  function syncProjections(): Promise<void> {
    projectionsRequested = true;
    if (projectionsPending) return projectionsPending;
    const pending = (async () => {
      while (projectionsRequested && !lifetime.signal.aborted) {
        projectionsRequested = false;
        if (projectionEpochError) {
          const error = projectionEpochError;
          projectionEpochError = undefined;
          if (error.scopeId) failedProjectionScopes.add(error.scopeId);
          if (++projectionFailures >= 3)
            throw await confirmProjectionHost(
              connection,
              error,
              lifetime.signal,
            );
        }
        try {
          await syncProjectionPass();
        } catch (error) {
          if (!(error instanceof HostProjectionError)) throw error;
          projectionEpochError = error;
        }
        if (projectionEpochError) projectionsRequested = true;
      }
      if (
        !lifetime.signal.aborted &&
        state.error instanceof HostProjectionError
      )
        change({ error: null });
    })().finally(() => {
      if (projectionsPending === pending) projectionsPending = undefined;
    });
    projectionsPending = pending;
    return pending;
  }
  async function syncProjectionPass() {
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
        !current ||
        !sameTarget(current.target, entry.target)
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
            if (
              controller.signal.aborted ||
              lifetime.signal.aborted ||
              projections.get(scope.scopeId) !== entry
            )
              return;
            if (event.type === "error") {
              controller.abort();
              entry.close();
              if (projections.get(scope.scopeId) === entry)
                projections.delete(scope.scopeId);
              if (
                scope.target.kind === "session" &&
                event.error instanceof HostRequestError &&
                event.error.code === "EPOCH_MISMATCH"
              ) {
                projectionEpochError = new HostProjectionError(
                  event.error,
                  scope.scopeId,
                );
                const alreadyPending = projectionsPending !== undefined;
                const recovery = syncProjections();
                if (!alreadyPending) void recovery.catch(report);
                return;
              }
              report(event.error);
              return;
            }
            const payload =
              event.type === "snapshot"
                ? event.snapshot.state
                : event.delta.payload;
            if (scope.target.kind === "session") {
              const parsed = asQueryResult({ kind: "session", value: payload });
              if (parsed.kind === "session") {
                updateSession(parsed.value);
                // 建立订阅不证明持续健康；只有失败过的 scope 真正交付增量才归还恢复预算。
                if (
                  event.type === "delta" &&
                  failedProjectionScopes.delete(scope.scopeId) &&
                  failedProjectionScopes.size === 0
                )
                  projectionFailures = 0;
              }
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
              void operationMetadata(payload, event.type === "snapshot").catch(
                report,
              );
            else if (scope.scopeId === "host.devices" && event.type === "delta")
              void refresh().catch(report);
          },
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          projections.get(scope.scopeId) !== entry
        )
          entry.close();
      } catch (error) {
        if (projections.get(scope.scopeId) === entry)
          projections.delete(scope.scopeId);
        if (!controller.signal.aborted) {
          controller.abort();
          if (
            scope.target.kind === "session" &&
            error instanceof HostRequestError &&
            error.code === "EPOCH_MISMATCH"
          )
            throw new HostProjectionError(error, scope.scopeId);
          throw error;
        }
      }
    }
  }
  async function readWorkspace(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocumentResult> {
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
    return result.value;
  }
  async function listWorkspaces(signal?: AbortSignal, after?: string) {
    const waiting = signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    const result = await connection.client.query(
      connection.buildQuery(
        "workspace.list",
        connection.hostTarget,
        after ? { after } : {},
      ),
      waiting,
    );
    waiting.throwIfAborted();
    if (result.kind !== "workspaces") throw new ContractValidationError();
    if (
      result.value.workspaces.some(
        ({ scope }) =>
          scope.target.hostId !== connection.attachment.hostId ||
          scope.target.kind !== "workspace" ||
          scope.target.sessionId !== undefined ||
          scope.target.sessionEpoch !== undefined,
      ) ||
      (after && result.value.nextCursor === after)
    )
      throw new ContractValidationError(
        "Workspace directory contains an invalid target or cursor",
      );
    return result.value;
  }
  async function loadWorkspace(
    workspaceId: string,
    signal?: AbortSignal,
    options?: { deferProjections?: boolean },
  ): Promise<WorkspaceDocumentResult> {
    const selection = ++workspaceSelection;
    const result = await readWorkspace(workspaceId, signal);
    const selected =
      result.document.value.archived && workspaceId !== "default"
        ? await readWorkspace("default", signal)
        : result;
    if (
      selection === workspaceSelection &&
      !signal?.aborted &&
      !lifetime.signal.aborted
    ) {
      change({ workspace: selected });
      if (!options?.deferProjections) await syncProjections();
    }
    return selected;
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
  function startRefresh(enumerateDevices: boolean) {
    // 元数据刷新是一次新的明确尝试；自动投影重建沿用 owner 的剩余预算。
    projectionFailures = 0;
    failedProjectionScopes.clear();
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
        connection.buildQuery(
          enumerateDevices ? "device.refresh" : "device.list",
          connection.hostTarget,
        ),
        lifetime.signal,
      );
      if (devices.kind !== "devices") throw new ContractValidationError();
      // 先恢复选中工作区与草稿归属；历史订阅仍不阻塞设备就绪。
      if (!state.workspace)
        await loadWorkspace("default", undefined, { deferProjections: true });
      change({
        devices: devices.value.devices,
        devicesStale: devices.value.stale,
        catalog,
        // 已认证连接与设备目录已可用；历史投影不阻塞明确的设备连接。
        status: "ready",
      });
      await syncProjections();
      change({ status: "ready", error: null });
    })()
      .catch((error: unknown) => {
        report(error);
        if (error instanceof HostProjectionError) change({ status: "ready" });
        else if (state.status === "connecting") change({ status: "error" });
        throw error;
      })
      .finally(() => {
        if (refreshPending === pending) {
          refreshPending = undefined;
          refreshEnumerating = false;
        }
      });
    refreshPending = pending;
    refreshEnumerating = enumerateDevices;
    return pending;
  }
  async function refresh(options?: { enumerateDevices?: boolean }) {
    lifetime.signal.throwIfAborted();
    if (enumerationPending) return enumerationPending;
    if (!refreshPending)
      return startRefresh(options?.enumerateDevices === true);
    if (!options?.enumerateDevices || refreshEnumerating) return refreshPending;
    // 用户展开设备列表时需要真实枚举；不能被在途的缓存读取吞掉。
    const pending = refreshPending
      .catch(() => lifetime.signal.throwIfAborted())
      .then(() => {
        lifetime.signal.throwIfAborted();
        return startRefresh(true);
      })
      .finally(() => {
        if (enumerationPending === pending) enumerationPending = undefined;
      });
    enumerationPending = pending;
    return pending;
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
        readers.retryAuthorized(session);
        // 打开已由 Native 确认；元数据恢复的读失败不能改写这次实际操作的结果。
        void (async () => {
          try {
            await refreshPending;
          } catch {
            lifetime.signal.throwIfAborted();
          }
          if (!lifetime.signal.aborted) await refresh();
        })().catch((error: unknown) => {
          if (!lifetime.signal.aborted && state.error !== error) report(error);
        });
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
    if (reference.hostId !== connection.attachment.hostId)
      throw new ContractValidationError();
    const result = await connection.client.query(
      connection.buildQuery("capture.status", referenceTarget(reference), {
        captureRef: reference,
      }),
      signal ?? lifetime.signal,
    );
    if (
      result.kind !== "capture_status" ||
      !sameTarget(result.value.captureRef, reference) ||
      (reference.revision !== undefined &&
        result.value.captureRef.revision !== reference.revision)
    )
      throw new ContractValidationError();
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
    const reference = params.receiptsRef;
    if (
      reference.hostId !== connection.attachment.hostId ||
      reference.kind !== "transfer_receipts"
    )
      throw new ContractValidationError();
    const result = await rawQuery(
      connection.buildQuery(
        "transfer.receiptsRead",
        referenceTarget(params.receiptsRef),
        params,
      ),
      signal,
    );
    if (
      result.kind !== "file_transfer_receipts" ||
      !sameTarget(result.value.receiptsRef, reference) ||
      (reference.revision !== undefined &&
        result.value.receiptsRef.revision !== reference.revision)
    )
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
    if (operation.error || operation.state !== "succeeded") {
      const error = operation.error
        ? new HostRequestError(operation.error)
        : failure("OPERATION_ABORTED", "Operation did not succeed");
      throw Object.assign(error, {
        executionHostId: operation.executionHostId,
        operationId: operation.operationId,
      });
    }
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
    target: Target,
    bytes: Uint8Array,
    signal?: AbortSignal,
    writeWaitMs?: string,
  ) {
    const session = sessionById(target.id);
    if (
      target.hostId !== connection.attachment.hostId ||
      target.kind !== "session" ||
      target.id !== target.sessionId ||
      target.sessionEpoch !== session.sessionEpoch
    )
      throw failure(
        "EPOCH_MISMATCH",
        "Session connection changed before sending",
      );
    if (session.readOnly)
      throw failure("PERMISSION_DENIED", "Session is read only");
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return invoke(
      {
        actionId: "session.tx",
        target: { ...target },
        params: {
          bytesBase64: btoa(binary),
          writeWaitMs: writeWaitMs ?? session.configuration.writeWaitMs,
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
    listWorkspaces,
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
      clearTimeout(streamNotification);
      for (const projection of projections.values()) projection.close();
      readers.dispose();
      projections.clear();

      listeners.clear();
      connection.dispose();
    },
  };
}
