/// <reference lib="dom" />
import { type Page } from "@playwright/test";
import type {
  QueryResult,
  RpcRequest,
  SharedSettings,
  WorkspaceDocument,
  ObjectRef,
  SettingsDocumentResult,
  SessionInputs,
  SessionMetrics,
  HostMetrics,
  HostError,
  Query,
  Call,
  FileMetadata,
  CaptureTailResult,
  Cursor,
  WorkspaceDocumentResult,
  SessionSnapshot,
  ReplayReadResult,
} from "@serial-workbench/contracts";
import defaults from "../../packages/contracts/src/generated/defaults.json" with { type: "json" };
import clientDefaults from "../../src/lib/generated/client-defaults.json" with { type: "json" };
import type {
  ClientStateSnapshot,
  ClientWindowState,
  DesktopAttachment,
  DesktopStatus,
  DiagnosticsReport,
  HostSettingsEffectsReceipt,
  WindowGeometry,
  SelectedFileResource,
  CaptureNameHint,
} from "../../src/lib/generated/bindings";

import { session, operation } from "../../src/features/workbench/test-fixtures";
import catalog from "../../packages/contracts/src/generated/catalog.json" with { type: "json" };
import { validateActionSpec } from "../../packages/contracts/src/generated/validators.mjs";
import type { DeviceDescriptor, Operation } from "@serial-workbench/contracts";

export type FixtureMediaResource = {
  reference: ObjectRef;
  name: string;
  mime: string;
  length: string;
  url: string;
};
export type ObservationFixture = {
  inputs: SessionInputs | "unsupported";
  metrics: SessionMetrics;
  hostMetrics: HostMetrics;
};
export type CaptureTailFixture = {
  results: Record<string, CaptureTailResult>;
  deferred?: string[];
  workspaces?: Record<string, WorkspaceDocument>;
};
/** 仅供无头渲染验收：明确的已附着回放和可校验记录，不代表实际 Host/录制文件。 */
export type ReplayLayoutFixture = {
  session: SessionSnapshot;
  page: ReplayReadResult;
  files: Record<
    string,
    { reference: ObjectRef; bytesBase64: string; fingerprint: string }
  >;
};
export type WorkbenchFixture = {
  rawSubscriptions: string[];
  emitRaw: (items: unknown[]) => number;
  unexpectedCommands: string[];
  hostQueries: string[];
  queryInputs: Query[];
  invocations: Call[];
  clientStateReads: number;
  sentBytes: string[];
  connectCalls: string[];
  mediaQueue: FixtureMediaResource[];
  mediaResources: Record<string, FixtureMediaResource>;
  selectedMedia: ObjectRef[];
  resolvedMedia: ObjectRef[];
  releasedMedia: string[];
  settingsWrites: SharedSettings[];
  nextMediaId: number;
  attachmentCalls: number;
  clientStateWrites: ClientWindowState[];
  workspaceWrites: WorkspaceDocument[];
  filePickerCalls: {
    role: string;
    generation: string;
    captureNameHint: CaptureNameHint | null;
  }[];
  captureTailRequests: { transport: "raw" | "control"; query: Query }[];
  captureTailResponses: string[];
  captureTailResults: Record<string, CaptureTailResult>;
  capturePermissionChecks: {
    id: string;
    decision: "allow" | "deny" | "unknown";
  }[];
  holdCaptureTail: (id: string) => void;
  releaseCaptureTail: (id: string) => void;
  setCapturePermission: (value: "allow" | "deny" | "unknown") => void;
  releaseHost: () => void;
  releaseDrafts: () => void;
  failRefresh: () => void;
  failHost: () => number;
};
declare global {
  interface Window {
    workbenchFixture: WorkbenchFixture;
  }
}
const fixtureSession = session();
const fixtureDevice: DeviceDescriptor = {
  deviceId: "device",
  hostId: "workbench-gui-host",
  systemName: "Virtual serial",
  fingerprint: { transport: "virtual", evidence: "unreliable" },
  capabilities: fixtureSession.capabilities,
};
const catalogItems = catalog.actions.map((item: unknown) => {
  if (!validateActionSpec(item)) throw new Error("Invalid Rust action fixture");
  return item;
});
const fixtureOperation: Operation = {
  ...operation("ui-send"),
  requestId: "00000000-0000-0000-0000-000000000001",
  actorId: "workbench-gui-actor",
  executionHostId: "workbench-gui-host",
  actionId: "session.tx",
  target: {
    hostId: "workbench-gui-host",
    kind: "session",
    id: "session",
    sessionId: "session",
    sessionEpoch: "1",
  },
  result: {
    kind: "tx",
    value: {
      operationId: "ui-send",
      sessionId: "session",
      sessionEpoch: "1",
      outcome: "accepted",
      bytesBase64: "U1RBVFVTPw==",
      byteStart: "0",
      byteEnd: "7",
      acceptedRanges: [{ start: "0", end: "7" }],
      unknownRanges: [],
      peerAcknowledged: false,
    },
  },
};
export async function seedWorkbenchFixture(
  page: Page,
  {
    sidebarCollapsed = false,
    backgroundIntensity = 90,
    motion = "reduced",
    currentPage = "workbench",
    language = "en",
    theme = "light",
    sharedSettings = {},
    observations,
    readOnly = false,
    captureTarget,
    fileMetadata,
    hostStart = "ready",
    draftAccess = "ready",
    drafts = {},
    workspace,
    captureTails,
    replay,
    connectFailure,
  }: {
    sidebarCollapsed?: boolean;
    backgroundIntensity?: number;
    motion?: "full" | "reduced";
    currentPage?: "workbench" | "settings";
    language?: "en" | "zh";
    theme?: "light" | "dark";
    sharedSettings?: Partial<SharedSettings>;
    observations?: ObservationFixture;
    readOnly?: boolean;
    captureTarget?: SelectedFileResource;
    fileMetadata?: FileMetadata;
    hostStart?: "ready" | "failed" | "pending";
    draftAccess?: "ready" | "failed" | "pending";
    drafts?: Record<string, string>;
    workspace?: WorkspaceDocument;
    captureTails?: CaptureTailFixture;
    replay?: ReplayLayoutFixture;
    connectFailure?: HostError;
  },
) {
  const desktopStatus: DesktopStatus = {
    trayAvailable: true,
    secondaryOpen: false,
    autostartSupported: true,
    runInBackground: false,
  };
  const viewport = page.viewportSize();
  const geometry: WindowGeometry = {
    width: viewport?.width ?? 1120,
    height: viewport?.height ?? 740,
    minWidth: 880,
    minHeight: 600,
    maxWidth: 1920,
    maxHeight: 1040,
    defaultWidth: 1120,
    defaultHeight: 740,
  };
  const attachment: DesktopAttachment = {
    generation: "1",
    attachment: {
      hostId: "workbench-gui-host",
      instanceEpoch: "1",
      protocolVersion: "0.1",
      catalogVersion: "1",
      actorId: "workbench-gui-actor",
      clientId: "workbench-gui-client",
      requestContext: "fixture-context",
      requestContextAcceptUntil: "2099-01-01T00:00:00Z",
      limits: {
        maxRequestBytes: "1048576",
        maxPageItems: "100",
        maxBatchBytes: "1048576",
        maxReaderQueueBytes: "1048576",
        resultRetentionMs: "60000",
        maxLeaseTtlMs: "60000",
      },
    },
  };
  const hostId = attachment.attachment.hostId;
  const settingsScope = {
    scopeId: "settings.shared",
    target: { hostId, kind: "settings", id: "shared" },
  };
  const workspaceScope = {
    scopeId: "workspace.default",
    target: { hostId, kind: "workspace", id: "default" },
  };
  const replayScope = replay
    ? {
        scopeId: "session.replay-layout",
        target: {
          hostId,
          kind: "session",
          id: replay.session.sessionId,
          sessionId: replay.session.sessionId,
          sessionEpoch: replay.session.sessionEpoch,
        },
      }
    : null;
  const replayOperation: Operation | null = replay
    ? {
        ...fixtureOperation,
        operationId: "fixture-attached-replay",
        rootOperationId: "fixture-attached-replay",
        actionId: "replay.open",
        target: { hostId, kind: "capture", id: "explicit-replay-layout" },
        revealTarget: {
          pageId: "workbench",
          sessionId: replay.session.sessionId,
          panelId: "replay",
        },
        result: {
          kind: "opened",
          value: {
            sessionId: replay.session.sessionId,
            sessionEpoch: replay.session.sessionEpoch,
            revision: replay.session.revision,
            reused: false,
          },
        },
      }
    : null;
  const replaySummary = replayOperation
    ? {
        operationId: replayOperation.operationId,
        executionHostId: replayOperation.executionHostId,
        actorId: replayOperation.actorId,
        actionId: replayOperation.actionId,
        target: replayOperation.target,
        executionMode: replayOperation.executionMode,
        state: replayOperation.state,
        revision: replayOperation.revision,
        revealTarget: replayOperation.revealTarget,
        acceptedAt: replayOperation.acceptedAt,
      }
    : null;
  const settingsDocument: SettingsDocumentResult = {
    scope: settingsScope,
    document: {
      revision: "1",
      value: {
        ...(defaults.settings as SharedSettings),
        language,
        theme,
        accent: "violet" as const,
        background: { kind: "bundled" as const, id: "bundled:001" },
        backgroundIntensity,
        motion,
        autoCheckUpdates: false,
        ...sharedSettings,
      },
    },
  };
  const workspaceDocument = {
    scope: workspaceScope,
    document: {
      revision: "1",
      value: workspace ?? (defaults.workspace as WorkspaceDocument),
    },
  };
  const queryResults = {
    "state.scopes": {
      kind: "scopes",
      value: {
        scopes: [
          settingsScope,
          workspaceScope,
          ...(replayScope
            ? [
                {
                  scopeId: "host.operations",
                  target: { hostId, kind: "host", id: hostId },
                },
                replayScope,
              ]
            : []),
        ],
      },
    },
    "catalog.list": {
      kind: "catalog",
      value: { catalogVersion: "1", items: catalogItems },
    },
    "device.list": {
      kind: "devices",
      value: { devices: [fixtureDevice], stale: false },
    },
    "recent.list": {
      kind: "recent",
      value: {
        revision: "1",
        entries: [
          {
            deviceId: fixtureDevice.deviceId,
            fingerprint: fixtureDevice.fingerprint,
            configuration: fixtureSession.configuration,
            openedAt: "2026-11-10T06:15:00Z",
          },
        ],
      },
    },
    "settings.read": { kind: "settings", value: settingsDocument },
    "workspace.read": { kind: "workspace", value: workspaceDocument },
  } satisfies Record<string, QueryResult>;
  const clientState = {
    formatVersion: "0.1",
    revision: "1",
    state: {
      ...(clientDefaults as ClientWindowState),
      currentPage,
      drafts,
      preferences: {
        ...(clientDefaults as ClientWindowState).preferences,
        sidebarCollapsed,
      },
    },
  } satisfies ClientStateSnapshot;
  const effects: HostSettingsEffectsReceipt = {
    hostId,
    instanceEpoch: attachment.attachment.instanceEpoch,
    revision: settingsDocument.document.revision,
    effects: { trayLanguage: true, networkMode: true, runInBackground: true },
  };
  // Exercise the production browser UI with controlled IPC, not native behavior.
  const fixturePayload = {
    hostAttachment: attachment,
    hostQueryResults: queryResults,
    settingsState: settingsDocument,
    workspaceState: workspaceDocument,
    initialClientState: clientState,
    settingsEffects: effects,
    appVersion: "0.1.0",
    desktop: desktopStatus,
    windowGeometry: geometry,
    openedSession: { ...fixtureSession, readOnly },
    observationProfile: observations ?? null,
    captureTarget: captureTarget ?? null,
    fileMetadata: fileMetadata ?? null,
    sentOperation: fixtureOperation,
    hostStart,
    draftAccess,
    captureProfile: captureTails ?? null,
    replayProfile: replay ?? null,
    replayScope,
    replayOperation,
    replaySummary,
    connectFailure: connectFailure ?? null,
  };
  await page.addInitScript((raw: string) => {
    const {
      hostAttachment,
      hostQueryResults,
      settingsState,
      workspaceState,
      initialClientState,
      settingsEffects,
      appVersion,
      desktop,
      windowGeometry,
      openedSession,
      observationProfile,
      captureTarget,
      fileMetadata,
      sentOperation,
      hostStart,
      draftAccess,
      captureProfile,
      replayProfile,
      replayScope,
      replayOperation,
      replaySummary,
      connectFailure,
    } = JSON.parse(raw) as typeof fixturePayload;
    const retained = JSON.parse(
      sessionStorage.getItem("workbench-native-fixture") ?? "null",
    ) as {
      client: ClientStateSnapshot;
      settings: SettingsDocumentResult;
      resources: Record<string, FixtureMediaResource>;
      workspace?: WorkspaceDocumentResult;
    } | null;
    let clientSnapshot: ClientStateSnapshot =
      retained?.client ?? initialClientState;
    let currentSettings: SettingsDocumentResult =
      retained?.settings ?? settingsState;
    let currentWorkspace: WorkspaceDocumentResult =
      retained?.workspace ?? workspaceState;
    const workspaceDocuments = new Map<string, WorkspaceDocumentResult>([
      [workspaceState.scope.target.id, workspaceState],
      [currentWorkspace.scope.target.id, currentWorkspace],
      ...Object.entries(captureProfile?.workspaces ?? {}).map(
        ([id, value]): [string, WorkspaceDocumentResult] => [
          id,
          {
            scope: {
              scopeId: "workspace." + id,
              target: { ...workspaceState.scope.target, id },
            },
            document: { revision: "1", value },
          },
        ],
      ),
    ]);
    for (const document of workspaceDocuments.values()) {
      const scopes = hostQueryResults["state.scopes"].value.scopes;
      if (!scopes.some((scope) => scope.scopeId === document.scope.scopeId))
        scopes.push(document.scope);
    }
    let hostAvailability = hostStart;
    let draftAvailability = draftAccess;
    let refreshUnavailable = false;
    const hostWaiters: (() => void)[] = [];
    const draftWaiters: (() => void)[] = [];
    const deferredTails = new Set(captureProfile?.deferred ?? []);
    const tailWaiters = new Map<string, (() => void)[]>();
    let tailPermission: "allow" | "deny" | "unknown" = "allow";
    const startupFailure = {
      code: "HOST_START_FAILED",
      message:
        "cargo run --secret=EXPLICIT_FIXTURE_SECRET C:/private/fixture-user",
      retryable: true,
    };
    let nextSubscription = 1;
    const callbacks = new Map<number, (value: unknown) => void>();
    const rawChannels = new Map<
      string,
      { callback: number; index: number; cursor: Cursor; sentBytes: bigint }
    >();
    const stateChannels = new Map<
      string,
      {
        callback: number;
        index: number;
        requestId: string;
        scopeId: string;
        workspace: boolean;
      }
    >();
    let nextCallback = 1;
    const fixture: WorkbenchFixture = {
      rawSubscriptions: [],
      emitRaw(items) {
        const bytes = items.reduce<bigint>(
          (total, item) =>
            total +
            BigInt(new TextEncoder().encode(JSON.stringify(item)).byteLength),
          0n,
        );
        for (const [subscriptionId, entry] of rawChannels) {
          entry.sentBytes += bytes;
          const previousCursor = entry.cursor;
          entry.cursor = {
            ...previousCursor,
            position: String(
              BigInt(previousCursor.position) + BigInt(items.length),
            ),
          };
          const batch = {
            subscriptionId,
            previousCursor,
            cursor: entry.cursor,
            items,
          };
          callbacks.get(entry.callback)?.({
            message: batch,
            index: entry.index++,
          });
        }
        return rawChannels.size;
      },
      unexpectedCommands: [],
      hostQueries: [],
      queryInputs: [],
      invocations: [],
      clientStateReads: 0,
      sentBytes: [],
      connectCalls: [],
      mediaQueue: [],
      mediaResources: retained?.resources ?? {},
      selectedMedia: [],
      resolvedMedia: [],
      releasedMedia: [],
      settingsWrites: [],
      nextMediaId: Object.keys(retained?.resources ?? {}).length + 1,
      attachmentCalls: 0,
      clientStateWrites: [],
      workspaceWrites: [],
      filePickerCalls: [],
      captureTailRequests: [],
      captureTailResponses: [],
      captureTailResults: captureProfile?.results ?? {},
      capturePermissionChecks: [],
      holdCaptureTail(id) {
        deferredTails.add(id);
      },
      releaseCaptureTail(id) {
        deferredTails.delete(id);
        tailWaiters
          .get(id)
          ?.splice(0)
          .forEach((resolve) => resolve());
      },
      setCapturePermission(value) {
        tailPermission = value;
      },
      releaseHost() {
        hostAvailability = "ready";
        hostWaiters.splice(0).forEach((resolve) => resolve());
      },
      releaseDrafts() {
        draftAvailability = "ready";
        draftWaiters.splice(0).forEach((resolve) => resolve());
      },
      failRefresh() {
        refreshUnavailable = true;
      },
      failHost() {
        let delivered = 0;
        // 只从实际活跃的工作区 Native 订阅交付故障，交给生产 HostProvider 退休连接。
        for (const [subscriptionId, entry] of [...stateChannels]) {
          if (!entry.workspace || !stateChannels.has(subscriptionId)) continue;
          const callback = callbacks.get(entry.callback);
          if (!callback) continue;
          delivered++;
          callback({
            message: {
              channel: "state",
              requestId: entry.requestId,
              body: { type: "error", error: startupFailure },
            },
            index: entry.index++,
          });
        }
        return delivered;
      },
    };
    const persist = () =>
      sessionStorage.setItem(
        "workbench-native-fixture",
        JSON.stringify({
          client: clientSnapshot,
          settings: currentSettings,
          resources: fixture.mediaResources,
          workspace: currentWorkspace,
        }),
      );
    const saveSettings = (
      value: SharedSettings,
      expectedRevision: unknown,
      requestId = "00000000-0000-0000-0000-000000000001",
    ): Operation => {
      if (expectedRevision !== currentSettings.document.revision)
        throw {
          code: "CONFLICT",
          message: "Fixture settings revision changed",
          retryable: false,
        };
      fixture.settingsWrites.push(value);
      currentSettings = {
        ...currentSettings,
        document: {
          revision: String(BigInt(currentSettings.document.revision) + 1n),
          value,
        },
      };
      persist();
      return {
        ...sentOperation,
        operationId: "settings-" + currentSettings.document.revision,
        requestId,
        rootOperationId: "settings-" + currentSettings.document.revision,
        actionId: "settings.save",
        target: currentSettings.scope.target,
        result: { kind: "settings", value: currentSettings },
      };
    };
    Object.assign(window, {
      workbenchFixture: fixture,
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (_event: string, id: number) =>
          callbacks.delete(id),
      },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        transformCallback(callback: (value: unknown) => void) {
          const id = nextCallback++;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        async invoke(command: string, args: Record<string, unknown> = {}) {
          switch (command) {
            case "plugin:event|listen":
              return args.handler;
            case "plugin:event|unlisten":
            case "host_delivery_ack":
            case "plugin:notification|register_listener":
            case "plugin:notification|remove_listener":
            case "complete_frontend_startup":
            case "set_window_work_state":
            case "save_workspace_route":
              return null;
            case "plugin:window|is_maximized":
            case "plugin:window|is_fullscreen":
            case "get_autostart_enabled":
              return false;
            case "plugin:app|version":
              return appVersion;
            case "plugin:app|tauri_version":
              return "2.0.0";
            case "host_attachment":
              fixture.attachmentCalls++;
              if (hostAvailability === "pending")
                await new Promise<void>((resolve) => hostWaiters.push(resolve));
              if (hostAvailability === "failed") throw startupFailure;
              return hostAttachment;
            case "choose_file_resource": {
              fixture.filePickerCalls.push({
                role: String(args.role),
                generation: String(args.generation),
                captureNameHint: args.captureNameHint as CaptureNameHint | null,
              });
              if (args.role === "captureTarget" && captureTarget)
                return captureTarget;
              if (args.role !== "media") break;
              const selected = fixture.mediaQueue.shift();
              if (!selected) return null;
              fixture.mediaResources[selected.reference.id] = selected;
              fixture.selectedMedia.push(selected.reference);
              persist();
              return {
                reference: selected.reference,
                name: selected.name,
                length: selected.length,
                mime: selected.mime,
              };
            }
            case "media_resolve": {
              const reference = args.reference as ObjectRef;
              const resource = fixture.mediaResources[reference.id];
              if (!resource)
                throw {
                  code: "NOT_FOUND",
                  message: "Unknown fixture media",
                  retryable: false,
                };
              fixture.resolvedMedia.push(reference);
              return {
                ticket: "media-ticket-" + fixture.resolvedMedia.length,
                url: resource.url,
                name: resource.name,
                mime: resource.mime,
              };
            }
            case "media_release":
              fixture.releasedMedia.push(String(args.ticket));
              return null;
            case "host_apply_document_intent": {
              const intent = args.intent as {
                kind: string;
                expectedRevision: string;
                params: { value: SharedSettings | WorkspaceDocument };
                workspaceId?: string;
              };
              if (intent.kind === "workspaceSave") {
                const base = workspaceDocuments.get(
                  intent.workspaceId ?? workspaceState.scope.target.id,
                );
                if (!base) throw { code: "NOT_FOUND" };
                if (intent.expectedRevision !== base.document.revision)
                  throw { code: "CONFLICT" };
                const value = intent.params.value as WorkspaceDocument;
                fixture.workspaceWrites.push(value);
                currentWorkspace = {
                  ...base,
                  document: {
                    revision: String(BigInt(base.document.revision) + 1n),
                    value,
                  },
                };
                workspaceDocuments.set(
                  currentWorkspace.scope.target.id,
                  currentWorkspace,
                );
                persist();
                return {
                  ...sentOperation,
                  operationId:
                    "workspace-" + currentWorkspace.document.revision,
                  rootOperationId:
                    "workspace-" + currentWorkspace.document.revision,
                  actionId: "workspace.save",
                  target: currentWorkspace.scope.target,
                  result: { kind: "workspace", value: currentWorkspace },
                };
              }
              if (intent.kind !== "settingsSave") break;
              return saveSettings(
                intent.params.value as SharedSettings,
                intent.expectedRevision,
              );
            }
            case "host_connect_device":
              fixture.connectCalls.push(String(args.deviceId));
              if (connectFailure) throw connectFailure;
              return openedSession;
            case "host_raw_request":
            case "host_request": {
              const request = args.request as RpcRequest;
              if (request.method === "action.invoke")
                fixture.invocations.push(request.params);
              if (
                request.method === "action.invoke" &&
                request.params.actionId === "capture.start"
              )
                return {
                  ok: true,
                  result: {
                    operation: {
                      ...sentOperation,
                      operationId: "fixture-capture-start",
                      rootOperationId: "fixture-capture-start",
                      requestId: request.params.requestId,
                      actionId: "capture.start",
                      target: request.params.target,
                      executionMode: request.params.executionMode,
                      result: {
                        kind: "reference",
                        value: {
                          resultRef: {
                            hostId: hostAttachment.attachment.hostId,
                            kind: "capture",
                            id: "fixture-capture",
                          },
                        },
                      },
                    },
                  },
                };
              if (
                request.method === "action.invoke" &&
                request.params.actionId === "settings.save"
              )
                return {
                  ok: true,
                  result: {
                    operation: saveSettings(
                      request.params.params.value as unknown as SharedSettings,
                      request.params.expectedRevision,
                      request.params.requestId,
                    ),
                  },
                };
              if (
                request.method === "action.invoke" &&
                request.params.actionId === "session.tx"
              ) {
                const bytesBase64 = request.params.params.bytesBase64;
                if (typeof bytesBase64 !== "string")
                  throw new Error("Expected TX bytes");
                fixture.sentBytes.push(bytesBase64);
                return {
                  ok: true,
                  result: {
                    operation: {
                      ...sentOperation,
                      requestId: request.params.requestId,
                    },
                  },
                };
              }
              if (request.method !== "action.query") break;
              const query = request.params;
              fixture.hostQueries.push(query.actionId);
              fixture.queryInputs.push(query);
              if (
                replayProfile &&
                query.actionId === "operation.get" &&
                query.params.operationId === replayOperation?.operationId
              )
                return {
                  ok: true,
                  result: {
                    kind: "operation",
                    value: { operation: replayOperation },
                  },
                };
              if (
                replayProfile &&
                query.actionId === "session.get" &&
                query.target.id === replayProfile.session.sessionId
              )
                return {
                  ok: true,
                  result: { kind: "session", value: replayProfile.session },
                };
              if (replayProfile && query.actionId === "replay.read") {
                if (
                  command !== "host_raw_request" ||
                  query.params.maxRecords !== "100" ||
                  query.params.maxBytes !== "65536" ||
                  query.params.sessionId !== replayProfile.session.sessionId ||
                  query.params.sessionEpoch !==
                    replayProfile.session.sessionEpoch
                )
                  throw new Error(
                    "Invalid explicit replay.read transport, target or budget",
                  );
                return {
                  ok: true,
                  result: { kind: "replay_read", value: replayProfile.page },
                };
              }
              if (replayProfile && query.actionId === "file.read") {
                const file = replayProfile.files[query.target.id];
                if (
                  !file ||
                  command !== "host_raw_request" ||
                  typeof query.params.offset !== "string" ||
                  typeof query.params.maxBytes !== "string"
                )
                  throw new Error("Unknown explicit replay record");
                const binary = atob(file.bytesBase64);
                const offset = BigInt(query.params.offset);
                const count = BigInt(query.params.maxBytes);
                if (
                  offset < 0n ||
                  offset >= BigInt(binary.length) ||
                  count <= 0n ||
                  count > 65536n
                )
                  throw new Error("Invalid replay file.read range");
                const part = binary.slice(
                  Number(offset),
                  Number(offset + count),
                );
                const next = offset + BigInt(part.length);
                return {
                  ok: true,
                  result: {
                    kind: "file_read",
                    value: {
                      fileRef: file.reference,
                      offset: String(offset),
                      nextOffset: String(next),
                      bytesBase64: btoa(part),
                      totalBytes: String(binary.length),
                      fingerprint: file.fingerprint,
                      atEnd: next === BigInt(binary.length),
                    },
                  },
                };
              }
              if (query.actionId === "stream.credit") {
                const subscriptionId = query.params.subscriptionId;
                if (typeof subscriptionId !== "string")
                  throw new Error("Invalid stream credit fixture request");
                return {
                  ok: true,
                  result: {
                    kind: "stream_credit",
                    value: {
                      ackCursor: query.params.ackCursor,
                      grantedBytesTotal: query.params.grantedBytesTotal,
                      sentBytesTotal: (
                        rawChannels.get(subscriptionId)?.sentBytes ?? 0n
                      ).toString(),
                      acknowledgedBytesTotal: (
                        rawChannels.get(subscriptionId)?.sentBytes ?? 0n
                      ).toString(),
                    },
                  },
                };
              }
              if (refreshUnavailable && query.actionId === "catalog.list")
                throw startupFailure;
              if (query.actionId === "capture.tail") {
                fixture.captureTailRequests.push({
                  transport: command === "host_raw_request" ? "raw" : "control",
                  query,
                });
                if (
                  command !== "host_raw_request" ||
                  query.params.maxRecords !== "100" ||
                  query.params.maxBytes !== "262144"
                )
                  throw new Error("Invalid capture.tail transport or budget");
                const reference = query.params.captureRef as ObjectRef;
                const result = fixture.captureTailResults[reference.id];
                if (!result)
                  throw new Error("Missing explicit capture.tail result");
                if (deferredTails.has(reference.id))
                  await new Promise<void>((resolve) => {
                    const pending = tailWaiters.get(reference.id) ?? [];
                    pending.push(resolve);
                    tailWaiters.set(reference.id, pending);
                  });
                fixture.captureTailResponses.push(reference.id);
                return {
                  ok: true,
                  result: { kind: "capture_tail", value: result },
                };
              }
              if (query.actionId === "workspace.read") {
                const document = workspaceDocuments.get(query.target.id);
                if (!document)
                  throw {
                    code: "NOT_FOUND",
                    message: "Unknown explicit workspace fixture",
                    retryable: false,
                  };
                return {
                  ok: true,
                  result: { kind: "workspace", value: document },
                };
              }
              if (query.actionId === "session.inputs")
                return observationProfile?.inputs &&
                  observationProfile.inputs !== "unsupported"
                  ? {
                      ok: true,
                      result: {
                        kind: "session_inputs",
                        value: observationProfile.inputs,
                      },
                    }
                  : {
                      ok: false,
                      error: {
                        code: "UNSUPPORTED_CAPABILITY",
                        message:
                          "UNSUPPORTED_CAPABILITY: explicit UI fixture has no input sampling",
                        retryable: false,
                      },
                    };
              if (query.actionId === "session.metrics" && observationProfile)
                return {
                  ok: true,
                  result: {
                    kind: "session_metrics",
                    value: observationProfile.metrics,
                  },
                };
              if (query.actionId === "host.metrics" && observationProfile)
                return {
                  ok: true,
                  result: {
                    kind: "host_metrics",
                    value: observationProfile.hostMetrics,
                  },
                };
              if (query.actionId === "file.metadata" && fileMetadata)
                return {
                  ok: true,
                  result: { kind: "file_metadata", value: fileMetadata },
                };
              if (query.actionId === "settings.read")
                return {
                  ok: true,
                  result: { kind: "settings", value: currentSettings },
                };
              if (query.actionId === "action.check") {
                const capture = query.params.actionId === "capture.tail";
                if (capture)
                  fixture.capturePermissionChecks.push({
                    id: query.target.id,
                    decision: tailPermission,
                  });
                if (capture && tailPermission === "unknown")
                  return {
                    ok: false,
                    error: {
                      code: "HOST_BUSY",
                      message: "Explicit permission observation unavailable",
                      retryable: true,
                    },
                  };
                return {
                  ok: true,
                  result: {
                    kind: "action_check",
                    value: {
                      actionId: query.params.actionId,
                      target: query.target,
                      allowed: !capture || tailPermission === "allow",
                    },
                  },
                };
              }
              if (query.actionId === "stream.cursor")
                return {
                  ok: true,
                  result: {
                    kind: "stream_cursor",
                    value: {
                      target: query.target,
                      cursor: {
                        hostId: hostAttachment.attachment.hostId,
                        instanceEpoch: "1",
                        scopeId: "session.raw",
                        position: "0",
                      },
                    },
                  },
                };
              if (query.actionId === "device.refresh")
                return {
                  ok: true,
                  result: hostQueryResults["device.list"],
                };
              if (query.actionId === "recent.list")
                return {
                  ok: true,
                  result: hostQueryResults["recent.list"],
                };
              if (query.actionId === "state.snapshot") {
                const scopeId = query.params.scopeId;
                if (
                  replayProfile &&
                  replayScope &&
                  replayOperation &&
                  typeof scopeId === "string" &&
                  (scopeId === "host.operations" ||
                    scopeId === replayScope.scopeId)
                )
                  return {
                    ok: true,
                    result: {
                      kind: "snapshot",
                      value: {
                        hostId: hostAttachment.attachment.hostId,
                        instanceEpoch: hostAttachment.attachment.instanceEpoch,
                        revision: "1",
                        cursor: {
                          hostId: hostAttachment.attachment.hostId,
                          instanceEpoch:
                            hostAttachment.attachment.instanceEpoch,
                          scopeId,
                          position: "0",
                        },
                        state:
                          scopeId === "host.operations"
                            ? { items: [replaySummary] }
                            : replayProfile.session,
                      },
                    },
                  };
                const state =
                  scopeId === currentSettings.scope.scopeId
                    ? currentSettings
                    : [...workspaceDocuments.values()].some(
                          (document) => document.scope.scopeId === scopeId,
                        )
                      ? [...workspaceDocuments.values()].find(
                          (document) => document.scope.scopeId === scopeId,
                        )!
                      : null;
                if (!state) break;
                return {
                  ok: true,
                  result: {
                    kind: "snapshot",
                    value: {
                      hostId: hostAttachment.attachment.hostId,
                      instanceEpoch: hostAttachment.attachment.instanceEpoch,
                      revision: state.document.revision,
                      cursor: {
                        hostId: hostAttachment.attachment.hostId,
                        instanceEpoch: hostAttachment.attachment.instanceEpoch,
                        scopeId,
                        position: "0",
                      },
                      state,
                    },
                  },
                };
              }
              const result =
                hostQueryResults[
                  query.actionId as keyof typeof hostQueryResults
                ];
              if (result) return { ok: true, result };
              break;
            }
            case "host_raw_subscribe": {
              const request = args.request as Query;
              const channel = args.channel;
              const after = request.params.after;
              if (
                request.actionId !== "stream.subscribe" ||
                !after ||
                typeof after !== "object" ||
                Array.isArray(after) ||
                typeof after.hostId !== "string" ||
                typeof after.instanceEpoch !== "string" ||
                typeof after.scopeId !== "string" ||
                typeof after.position !== "string" ||
                !channel ||
                typeof channel !== "object" ||
                !("id" in channel) ||
                typeof channel.id !== "number"
              )
                throw new Error("Invalid raw subscription fixture request");
              const subscriptionId = `workbench-gui-subscription-${nextSubscription++}`;
              rawChannels.set(subscriptionId, {
                callback: channel.id,
                index: 0,
                cursor: {
                  hostId: after.hostId,
                  instanceEpoch: after.instanceEpoch,
                  scopeId: after.scopeId,
                  position: after.position,
                },
                sentBytes: 0n,
              });
              fixture.rawSubscriptions.push(subscriptionId);
              return subscriptionId;
            }
            case "host_subscribe": {
              const request = args.request as Query;
              const channel = args.channel;
              if (
                request.actionId !== "state.subscribe" ||
                typeof request.requestId !== "string" ||
                typeof request.params.scopeId !== "string" ||
                !channel ||
                typeof channel !== "object" ||
                !("id" in channel) ||
                typeof channel.id !== "number"
              )
                throw new Error("Invalid state subscription fixture request");
              const subscriptionId = `workbench-gui-subscription-${nextSubscription++}`;
              stateChannels.set(subscriptionId, {
                callback: channel.id,
                index: 0,
                requestId: request.requestId,
                scopeId: request.params.scopeId,
                workspace: request.target.kind === "workspace",
              });
              return subscriptionId;
            }
            case "host_raw_unsubscribe":
              rawChannels.delete(String(args.subscriptionId));
              fixture.rawSubscriptions = [...rawChannels.keys()];
              return null;
            case "host_unsubscribe": {
              const subscriptionId = String(args.subscriptionId);
              const entry = stateChannels.get(subscriptionId);
              stateChannels.delete(subscriptionId);
              if (entry) callbacks.delete(entry.callback);
              return null;
            }
            case "client_state_read":
              fixture.clientStateReads++;
              if (draftAvailability === "pending")
                await new Promise<void>((resolve) =>
                  draftWaiters.push(resolve),
                );
              if (draftAvailability === "failed")
                throw {
                  code: "STORAGE_CORRUPT",
                  message: "EXPLICIT_DRAFT_READ_FAILURE",
                  retryable: true,
                };
              return clientSnapshot;
            case "client_state_save":
              if (args.expectedRevision !== clientSnapshot.revision)
                throw { code: "CONFLICT" };
              clientSnapshot = {
                ...clientSnapshot,
                revision: String(BigInt(clientSnapshot.revision) + 1n),
                state: args.state as ClientStateSnapshot["state"],
              };
              fixture.clientStateWrites.push(clientSnapshot.state);
              persist();
              return clientSnapshot;
            case "apply_host_settings_effects":
              return {
                ...settingsEffects,
                revision: currentSettings.document.revision,
              };
            case "get_diagnostics_report":
              return {
                appVersion,
                tauriVersion: "2.0.0",
                platform: "headless-fixture",
                architecture: "x64",
                windowLabel: "main",
                settingsRevision: currentSettings.document.revision,
                desktop,
                autostartEnabled: false,
                updaterConfigured: false,
                recentLogs: "",
              } satisfies DiagnosticsReport;
            case "get_desktop_status":
              return desktop;
            case "get_window_geometry":
              return windowGeometry;
            case "recovery_status":
              return {
                active: false,
                reason: null,
                pending: false,
                archiveId: null,
              };
            case "get_workspace":
              // Shell route restoration still uses this registered command.
              return {
                routes: { main: `/${clientSnapshot.state.currentPage}` },
                secondaryOpen: false,
              };
            case "activation_snapshot":
              return [];
            case "get_update_snapshot":
            case "record_frontend_error":
              return null;
          }
          fixture.unexpectedCommands.push(command);
          throw new Error(`Unexpected IPC fixture command: ${command}`);
        },
      },
    });
  }, JSON.stringify(fixturePayload));
}
