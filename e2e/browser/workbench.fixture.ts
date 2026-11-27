/// <reference lib="dom" />
import { type Page } from "@playwright/test";
import { catalog, clientDefaults, defaults } from "./json-fixtures";
import { TX_MAX_BYTES } from "../../packages/contracts/src/generated/types";
import type {
  ActionSpec,
  BrowserAccessState,
  BrowserTakeoverRequest,
  LanAccessParams,
  LanAccessResult,
  LanRoute,
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
  CaptureRedactionPreviewResult,
  FileMetadata,
  FileReadResult,
  NodePackageInstallation,
  NodePackageSourceKey,
  NodePackageSummary,
  CaptureTailResult,
  Cursor,
  WorkspaceDocumentResult,
  SessionSnapshot,
  ReplayReadResult,
  ReplaySearchPage,
  ExperimentInspection,
} from "@serial-workbench/contracts";
import type {
  ClientStateSnapshot,
  ClientWindowState,
  DesktopAttachment,
  DesktopStatus,
  DiagnosticsReport,
  HostSettingsEffectsReceipt,
  LocalNodeIntent,
  LocalBrowserAccess,
  WindowGeometry,
  SelectedFileResource,
  CaptureNameHint,
} from "../../src/lib/generated/bindings";

import { session, operation } from "../../src/features/workbench/test-fixtures";
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
  searchPages?: ReplaySearchPage[];
  files: Record<
    string,
    { reference: ObjectRef; bytesBase64: string; fingerprint: string }
  >;
};
export type WorkbenchFixture = {
  setExperimentRecordingReadable: (readable: boolean, notify: boolean) => void;
  setNodeThemes: (themes: FixtureNodeThemes) => void;
  registerFramingAction: () => void;
  dropTransferFile: (x: number, y: number, generation?: string) => number;
  transferDropClaims: string[];
  setTransferProgress: (
    accepted: string,
    unknown: string,
    state: "running" | "cancel_requested" | "cancelled",
    read?: string,
  ) => number;
  browserTakeoverDecisions: { takeoverId: string; approve: boolean }[];
  lanCommands: LanAccessParams[];
  copiedLanInfo: string[];
  emitSharedActivity: (items: unknown[]) => number;
  lanSwitches: { generation: string | null; route: LanRoute | null }[];
  rawSubscriptions: string[];
  emitRaw: (items: unknown[], sessionId?: string) => number;
  endRaw: (error: HostError, sessionId?: string) => number;
  unexpectedCommands: string[];
  hostQueries: string[];
  pluginIntents: LocalNodeIntent[];
  pluginInstallFailure: boolean;
  limitPluginReads: boolean;
  queryInputs: Query[];
  configureCheckDelayMs: number;
  configureAllowed: boolean;
  deniedReplayReads: string[];
  deniedRawSessions: string[];
  rawCursorGate?: Promise<void>;
  releaseRawCursor?: () => void;
  sendHistoryReadable: boolean;
  manualSendRevision: string;
  manualSendAcceptedBytes?: number;
  invocations: Call[];
  clientStateReads: number;
  sentBytes: string[];
  savedTextExports: { name: string; content: string }[];
  chartArtifactSaves: { generation: string; operationId: string }[];
  chartArtifactSaveResult: boolean;
  openedExternalLinks: string[];
  connectCalls: string[];
  connectRequests: { deviceId: string; params: unknown }[];
  windowWorkNames: string[];
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
  automationCursorPosition: string;
  suiteConfigurationRevision?: string;
  calendarSessionRevision?: string;
  automationCursorScope?: string;
  automationObserveFailures: number;
  finishAutomationCancellation: () => void;
  automationRuleReplyHeld: "preflight" | "admission" | "cancelCheck" | null;
  emitRuleOperation: (markMatched?: boolean) => number;
  emitCalendarPeer: () => number;
  calendarCheckHeld: boolean;
  releaseCalendarCheck: () => void;
  releaseAutomationRuleReply: () => void;
  finishRuleNotification: () => void;
  automationCancelReplyHeld: boolean;
  releaseAutomationCancelReply: () => void;
  releaseDefinitionRead: () => void;
  holdNextFraming: () => void;
  setFramingResult: (page: FileReadResult) => void;
  settleFramingCancellation: () => void;
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
type FixtureNodeThemes = Extract<
  QueryResult,
  { kind: "node_themes" }
>["value"]["themes"];
type DefinitionFileFixture = {
  selected: SelectedFileResource;
  metadata?: FileMetadata;
  page?: FileReadResult;
  holdRead?: boolean;
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
    captureRedactionPreview,
    transferSource,
    fileMetadata,
    hostStart = "ready",
    hostFailure,
    draftAccess = "ready",
    drafts = {},
    workspace,
    captureTails,
    replay,
    replayPeer,
    connectFailure,
    openedConfiguration,
    openedCapabilities,
    connectionDefaults,
    device,
    secondDevice,
    plugin,
    pendingTakeover,
    lanOwner,
    nodeThemes = [],
    framing,
    definitionFiles,
    sendHistory = false,
    manualSendReceipts = false,
    automation,
    diagnosticLogs,
    experiment,
    extraActions = [],
    extensionQueryResults = {},
  }: {
    sidebarCollapsed?: boolean;
    backgroundIntensity?: number;
    diagnosticLogs?: string;
    experiment?: ExperimentInspection;
    motion?: "full" | "reduced";
    currentPage?: "workbench" | "settings";
    language?: "en" | "zh";
    theme?: "light" | "dark";
    sharedSettings?: Partial<SharedSettings>;
    observations?: ObservationFixture;
    sendHistory?: boolean;
    manualSendReceipts?: boolean;
    readOnly?: boolean;
    captureTarget?: SelectedFileResource;
    captureRedactionPreview?: CaptureRedactionPreviewResult;
    transferSource?: SelectedFileResource;
    fileMetadata?: FileMetadata;
    hostStart?: "ready" | "failed" | "pending";
    hostFailure?: HostError;
    draftAccess?: "ready" | "failed" | "pending";
    drafts?: Record<string, string>;
    workspace?: WorkspaceDocument;
    captureTails?: CaptureTailFixture;
    replay?: ReplayLayoutFixture;
    replayPeer?: ReplayLayoutFixture;
    connectFailure?: HostError;
    openedConfiguration?: SessionSnapshot["configuration"];
    openedCapabilities?: SessionSnapshot["capabilities"];
    connectionDefaults?: ClientWindowState["connectionDefaults"];
    device?: DeviceDescriptor;
    secondDevice?: DeviceDescriptor;
    pendingTakeover?: BrowserTakeoverRequest;
    lanOwner?: { hostId: string; address: string };
    nodeThemes?: FixtureNodeThemes;
    framing?: {
      action: ActionSpec;
      page: FileReadResult;
      initiallyUnavailable?: boolean;
      dependencies?: Operation["dependencies"];
    };
    definitionFiles?: DefinitionFileFixture[];
    automation?: {
      action: ActionSpec;
      state: "ready" | "held" | "denied";
      delayRuleReply?: "preflight" | "admission" | "cancelCheck";
      delayFirstCancellationReply?: boolean;
      calendarInitiallyQueued?: boolean;
      delaySecondCalendarCheck?: boolean;
      sequenceRetry?: boolean;
      connectionReport?: { steps: unknown[]; [key: string]: unknown };
      sequenceSuiteOutcomes?: ("passed" | "failed" | "written")[];
    };
    extraActions?: ActionSpec[];
    extensionQueryResults?: Record<
      string,
      Extract<QueryResult, { kind: "extension" }>
    >;
    plugin?: {
      archive: SelectedFileResource;
      installation: NodePackageInstallation;
      source?: NodePackageSourceKey;
      initiallyInstalled?: boolean;
    };
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
      protocolVersion: "1.0",
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
  const replayCatalog = catalogItems.filter(
    (item) => item.actionId !== "replay.search" || replay?.searchPages,
  );
  const workbenchCatalog = replay?.page.playback
    ? replayCatalog
    : replayCatalog.map((item) => {
        const properties = item.inputSchema.properties;
        if (
          (item.actionId !== "replay.read" &&
            item.actionId !== "replay.control") ||
          !properties ||
          typeof properties !== "object" ||
          Array.isArray(properties)
        )
          return item;
        const legacyProperties = { ...properties };
        delete legacyProperties.singleStep;
        delete legacyProperties.reportPlayback;
        delete legacyProperties.inspectPlayback;
        delete legacyProperties.playback;
        return {
          ...item,
          inputSchema: { ...item.inputSchema, properties: legacyProperties },
        };
      });
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
  const peerScope = replayPeer
    ? {
        scopeId: "session.replay-layout-peer",
        target: {
          hostId,
          kind: "session",
          id: replayPeer.session.sessionId,
          sessionId: replayPeer.session.sessionId,
          sessionEpoch: replayPeer.session.sessionEpoch,
        },
      }
    : null;
  const peerOperation: Operation | null =
    replayPeer && replayOperation
      ? {
          ...replayOperation,
          operationId: "fixture-attached-replay-peer",
          rootOperationId: "fixture-attached-replay-peer",
          target: {
            hostId,
            kind: "capture",
            id: "explicit-replay-layout-peer",
          },
          revealTarget: {
            pageId: "workbench",
            sessionId: replayPeer.session.sessionId,
            panelId: "replay",
          },
          result: {
            kind: "opened",
            value: {
              sessionId: replayPeer.session.sessionId,
              sessionEpoch: replayPeer.session.sessionEpoch,
              revision: replayPeer.session.revision,
              reused: false,
            },
          },
        }
      : null;
  const peerSummary =
    peerOperation && replaySummary
      ? {
          ...replaySummary,
          operationId: peerOperation.operationId,
          target: peerOperation.target,
          revealTarget: peerOperation.revealTarget,
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
          ...(pendingTakeover
            ? [
                {
                  scopeId: "host.activity",
                  target: { hostId, kind: "host", id: hostId },
                },
              ]
            : []),
          ...(replayScope || sendHistory || transferSource
            ? [
                {
                  scopeId: "host.operations",
                  target: { hostId, kind: "host", id: hostId },
                },
              ]
            : []),
          ...(replayScope ? [replayScope] : []),
          ...(peerScope ? [peerScope] : []),
        ],
      },
    },
    "catalog.list": {
      kind: "catalog",
      value: {
        catalogVersion: "1",
        items: [
          ...workbenchCatalog,
          ...(framing && !framing.initiallyUnavailable ? [framing.action] : []),
          ...(automation ? [automation.action] : []),
          ...extraActions,
        ],
      },
    },
    "device.list": {
      kind: "devices",
      value: {
        devices: [
          device ?? fixtureDevice,
          ...(secondDevice ? [secondDevice] : []),
        ],
        stale: false,
      },
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
    ...(experiment
      ? {
          "workspace.experiment.export": {
            kind: "experiment_package",
            value: experiment.experiment,
          },
          "workspace.experiment.inspect": {
            kind: "experiment_inspection",
            value: experiment,
          },
          "node.packages.list": {
            kind: "node_packages",
            value: {
              revision: "1",
              packages: experiment.experiment.parsers.map((item) => ({
                id: item.id,
                version: item.version,
                archiveSha256: item.archiveSha256,
                enabled: true,
                sourceVerified: true,
                executionApproved: true,
              })),
            },
          },
        }
      : {}),
  } satisfies Record<string, QueryResult>;
  const clientState = {
    formatVersion: "0.1",
    revision: "1",
    state: {
      ...(clientDefaults as ClientWindowState),
      currentPage,
      drafts,
      ...(connectionDefaults ? { connectionDefaults } : {}),
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
    extensionQueryResults,
    settingsState: settingsDocument,
    workspaceState: workspaceDocument,
    initialClientState: clientState,
    settingsEffects: effects,
    appVersion: "0.1.0",
    desktop: desktopStatus,
    windowGeometry: geometry,
    openedSession: {
      ...fixtureSession,
      deviceId: device?.deviceId ?? fixtureSession.deviceId,
      readOnly,
      configuration: openedConfiguration ?? fixtureSession.configuration,
      capabilities: openedCapabilities ?? fixtureSession.capabilities,
    },
    secondSession: secondDevice
      ? {
          ...fixtureSession,
          sessionId: "second-session",
          deviceId: secondDevice.deviceId,
        }
      : undefined,
    observationProfile: observations ?? null,
    captureTarget: captureTarget ?? null,
    captureRedactionPreview,
    transferSource,
    fileMetadata: fileMetadata ?? null,
    sentOperation: fixtureOperation,
    sendHistory,
    manualSendReceipts,
    txMaxBytes: TX_MAX_BYTES,
    hostStart,
    hostFailure,
    draftAccess,
    captureProfile: captureTails ?? null,
    replayProfile: replay ?? null,
    replayScope,
    replayOperation,
    replaySummary,
    replayPeer,
    peerScope,
    peerOperation,
    peerSummary,
    connectFailure: connectFailure ?? null,
    plugin,
    pendingTakeover,
    lanOwner,
    nodeThemes,
    framing,
    definitionFiles,
    automation,
    diagnosticLogs,
  };
  await page.addInitScript((raw: string) => {
    const {
      hostAttachment,
      hostQueryResults,
      extensionQueryResults,
      settingsState,
      workspaceState,
      initialClientState,
      settingsEffects,
      appVersion,
      desktop,
      windowGeometry,
      openedSession,
      secondSession,
      observationProfile,
      captureTarget,
      captureRedactionPreview,
      transferSource,
      fileMetadata,
      sentOperation,
      sendHistory,
      manualSendReceipts,
      txMaxBytes,
      hostStart,
      hostFailure,
      draftAccess,
      captureProfile,
      replayProfile,
      replayScope,
      replayOperation,
      replaySummary,
      replayPeer,
      peerScope,
      peerOperation,
      peerSummary,
      connectFailure,
      plugin,
      pendingTakeover,
      lanOwner,
      nodeThemes,
      framing,
      definitionFiles,
      automation,
      diagnosticLogs,
    } = JSON.parse(raw) as typeof fixturePayload;
    let automationOperation: Operation | undefined;
    let operationPosition = 0;
    let transferOperation: Operation | undefined;
    let sourceRead = "0";
    let delayedCancellationReply = automation?.delayFirstCancellationReply;
    let releaseCancellationReply: (() => void) | undefined;
    let delayedRuleReply = automation?.delayRuleReply;
    let releaseRuleReply: (() => void) | undefined;
    async function holdRuleReply(
      phase: "preflight" | "admission" | "cancelCheck",
    ) {
      if (delayedRuleReply !== phase) return;
      delayedRuleReply = undefined;
      fixture.automationRuleReplyHeld = phase;
      await new Promise<void>((resolve) => {
        releaseRuleReply = resolve;
      });
      releaseRuleReply = undefined;
      fixture.automationRuleReplyHeld = null;
    }
    let ruleRuns = 0;
    let calendarRuns = 0;
    let calendarChecks = 0;
    let releaseCalendarCheck: (() => void) | undefined;
    let suiteCase = 0;
    let automationFile = "";
    let framingOperation: Operation | undefined;
    let holdFraming = false;
    let nextFramingResult = framing?.page;
    const framingResults = new Map<string, FileReadResult>();
    let chosenDefinition: DefinitionFileFixture | undefined;
    let releaseDefinitionRead: (() => void) | undefined;
    let replayPlayback = replayProfile?.page.playback;
    let replayReadIndex = 0;
    let replayReaderGeneration = replayProfile?.page.readerGeneration ?? "1";
    let replaySearchId: string | undefined;
    const replayControls = new Map<string, Operation>();
    const replayOrdinal = (record: ReplayReadResult["records"][number]) =>
      record.kind === "inline"
        ? record.record.recordOrdinal
        : record.recordOrdinal;
    const replayPosition = (records: ReplayReadResult["records"] = []) => {
      if (!replayProfile) throw new Error("Missing explicit replay profile");
      const next = replayProfile.page.records[replayReadIndex];
      return {
        records,
        readerGeneration: replayReaderGeneration,
        nextRecord: next ? replayOrdinal(next) : replayProfile.page.nextRecord,
        atEnd: next === undefined,
      };
    };
    const playbackPage = (
      records: ReplayReadResult["records"] = [],
    ): ReplayReadResult => {
      if (!replayPlayback) throw new Error("Missing explicit replay playback");
      return {
        ...replayPosition(records),
        playback: {
          ...replayPlayback,
          breakpointHit: replayPlayback.paused && replayPlayback.breakpointHit,
        },
      };
    };
    const validReplayTarget = (target: Query["target"]) =>
      target.kind === "session" &&
      target.hostId === replayScope?.target.hostId &&
      target.id === replayScope?.target.id &&
      target.sessionId === replayScope?.target.sessionId &&
      target.sessionEpoch === replayScope?.target.sessionEpoch;
    let remoteAttachment: DesktopAttachment | undefined;
    let remoteGeneration = 1;
    const sharedDevice = {
      ...hostQueryResults["device.list"].value.devices[0]!,
      deviceId: "shared-serial",
      hostId: lanOwner?.hostId ?? "",
      systemName: "Shared UART",
    };
    const sharedSession = {
      ...openedSession,
      sessionId: "shared-session",
      deviceId: sharedDevice.deviceId,
    };
    const sharedScope = {
      scopeId: "session.shared-session",
      target: {
        hostId: sharedDevice.hostId,
        kind: "session",
        id: sharedSession.sessionId,
        sessionId: sharedSession.sessionId,
        sessionEpoch: sharedSession.sessionEpoch,
      },
    };
    const sharedActivityScope = {
      ...sharedScope,
      scopeId: "session-activity:shared-session",
    };
    let sharedActivityRevision = 0n;
    let sharedActivity: { items: unknown[] } = { items: [] };
    function summarizePlugin({
      manifest,
      archiveSha256,
      enabled,
      executionTrust,
      verifiedSource,
    }: NodePackageInstallation): NodePackageSummary {
      return {
        id: manifest.id,
        displayName: manifest.displayName,
        version: manifest.version,
        archiveSha256,
        enabled,
        executionApproved: Boolean(executionTrust),
        sourceVerified: Boolean(verifiedSource),
      };
    }
    let pluginRevision = plugin?.initiallyInstalled ? 1 : 0;
    let activePluginReads = 0;
    let pluginSummary = plugin?.initiallyInstalled
      ? summarizePlugin(plugin.installation)
      : undefined;
    const retained = JSON.parse(
      sessionStorage.getItem("workbench-native-fixture") ?? "null",
    ) as {
      client: ClientStateSnapshot;
      settings: SettingsDocumentResult;
      resources: Record<string, FixtureMediaResource>;
      workspace?: WorkspaceDocumentResult;
      workspaces?: WorkspaceDocumentResult[];
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
    for (const document of retained?.workspaces ?? [])
      workspaceDocuments.set(document.scope.target.id, document);
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
    const startupFailure = hostFailure ?? {
      code: "HOST_START_FAILED",
      message:
        "cargo run --secret=EXPLICIT_FIXTURE_SECRET C:/private/fixture-user",
      retryable: true,
    };
    let nextSubscription = 1;
    const callbacks = new Map<number, (value: unknown) => void>();
    const rawChannels = new Map<
      string,
      {
        callback: number;
        lifecycle: number;
        requestId: string;
        index: number;
        lifecycleIndex: number;
        sessionId?: string;
        cursor: Cursor;
        sentBytes: bigint;
      }
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
    const catalogListeners = new Set<number>();
    let themes = nodeThemes;
    let browserAccess: BrowserAccessState = { kind: "disabled" };
    let lanAccess: LanAccessResult = {
      localPeer: { hostId: "workbench-gui-host", fingerprint: "a".repeat(64) },
      listener: { kind: "disabled" },
      peers: [],
    };
    function broadcastOperation(operation: Operation) {
      const {
        operationId,
        executionHostId,
        actorId,
        actionId,
        target,
        executionMode,
        state,
        revision,
        revealTarget,
        acceptedAt,
      } = operation;
      const scopeId = "host.operations";
      const previousCursor = {
        hostId: executionHostId,
        instanceEpoch: hostAttachment.attachment.instanceEpoch,
        scopeId,
        position: String(operationPosition++),
      };
      let delivered = 0;
      for (const [subscriptionId, entry] of stateChannels) {
        if (entry.scopeId !== scopeId) continue;
        const callback = callbacks.get(entry.callback);
        if (!callback) continue;
        delivered++;
        callback({
          message: {
            channel: "state",
            requestId: entry.requestId,
            body: {
              type: "delta",
              subscriptionId,
              delta: {
                previousCursor,
                cursor: {
                  ...previousCursor,
                  position: String(operationPosition),
                },
                revision: String(operationPosition + 1),
                eventType: "operations.changed",
                payload: {
                  items: [
                    {
                      operationId,
                      executionHostId,
                      actorId,
                      actionId,
                      target,
                      executionMode,
                      state,
                      revision,
                      revealTarget,
                      acceptedAt,
                    },
                  ],
                },
              },
            },
          },
          index: entry.index++,
        });
      }
      return delivered;
    }
    function catalogChanged() {
      for (const id of catalogListeners)
        callbacks.get(id)?.({
          event: "app://host-catalog-changed",
          id,
          payload: hostAttachment.generation,
        });
    }
    const dropListeners = new Set<number>();
    let experimentRecordingReadable = true;
    const fixture: WorkbenchFixture = {
      setExperimentRecordingReadable(readable, notify) {
        experimentRecordingReadable = readable;
        if (notify) catalogChanged();
      },
      transferDropClaims: [],
      dropTransferFile(x, y, generation = hostAttachment.generation) {
        for (const id of dropListeners)
          callbacks.get(id)?.({
            event: "app://transfer-file-drop",
            id,
            payload: { ticket: "91", generation, x, y },
          });
        return dropListeners.size;
      },
      setTransferProgress(accepted, unknown, state, read) {
        if (
          !transferOperation ||
          transferOperation.result?.kind !== "file_transfer"
        )
          return 0;
        if (read !== undefined) sourceRead = read;
        transferOperation = {
          ...transferOperation,
          state,
          revision: String(BigInt(transferOperation.revision) + 1n),
          settledAt:
            state === "cancelled" ? sentOperation.settledAt : undefined,
          result: {
            kind: "file_transfer",
            value: {
              ...transferOperation.result.value,
              accepted,
              unknown,
              receiptsRef: {
                ...transferOperation.result.value.receiptsRef,
                ...(state === "cancelled" ? { revision: "1" } : {}),
              },
            },
          },
        };
        return broadcastOperation(transferOperation);
      },
      setNodeThemes(next) {
        themes = next;
        catalogChanged();
      },
      registerFramingAction() {
        const catalog = hostQueryResults["catalog.list"].value;
        if (
          !framing ||
          catalog.items.some(
            (entry) => entry.actionId === framing.action.actionId,
          )
        )
          return;
        catalog.items.push(framing.action);
        catalog.catalogVersion = "2";
        catalogChanged();
      },
      browserTakeoverDecisions: [],
      lanCommands: [],
      copiedLanInfo: [],
      lanSwitches: [],
      rawSubscriptions: [],
      emitSharedActivity(items) {
        if (!remoteAttachment) return 0;
        const { hostId, instanceEpoch } = remoteAttachment.attachment;
        const scopeId = sharedActivityScope.scopeId;
        const previousCursor = {
          hostId,
          instanceEpoch,
          scopeId,
          position: String(sharedActivityRevision),
        };
        const revision = String(++sharedActivityRevision);
        const cursor = { ...previousCursor, position: revision };
        sharedActivity = { items };
        let delivered = 0;
        for (const [subscriptionId, entry] of stateChannels) {
          if (entry.scopeId !== scopeId) continue;
          const callback = callbacks.get(entry.callback);
          if (!callback) continue;
          delivered++;
          callback({
            message: {
              channel: "state",
              requestId: entry.requestId,
              body: {
                type: "delta",
                subscriptionId,
                delta: {
                  previousCursor,
                  cursor,
                  revision,
                  eventType: "activity.changed",
                  payload: sharedActivity,
                },
              },
            },
            index: entry.index++,
          });
        }
        return delivered;
      },
      emitRaw(items, sessionId) {
        const bytes = items.reduce<bigint>(
          (total, item) =>
            total +
            BigInt(new TextEncoder().encode(JSON.stringify(item)).byteLength),
          0n,
        );
        let delivered = 0;
        for (const [subscriptionId, entry] of rawChannels) {
          if (sessionId && sessionId !== entry.sessionId) continue;
          delivered++;
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
        return delivered;
      },
      endRaw(error, sessionId) {
        let delivered = 0;
        for (const [subscriptionId, entry] of [...rawChannels]) {
          if (sessionId && sessionId !== entry.sessionId) continue;
          const callback = callbacks.get(entry.lifecycle);
          if (!callback) continue;
          delivered++;
          callback({
            message: {
              channel: "raw",
              requestId: entry.requestId,
              body: { type: "subscriptionEnded", subscriptionId, error },
            },
            index: entry.lifecycleIndex++,
          });
        }
        return delivered;
      },
      unexpectedCommands: [],
      hostQueries: [],
      pluginIntents: [],
      pluginInstallFailure: false,
      limitPluginReads: false,
      queryInputs: [],
      configureCheckDelayMs: 0,
      configureAllowed: true,
      deniedReplayReads: [],
      deniedRawSessions: [],
      sendHistoryReadable: true,
      manualSendRevision: openedSession.revision,
      invocations: [],
      clientStateReads: 0,
      sentBytes: [],
      savedTextExports: [],
      chartArtifactSaves: [],
      chartArtifactSaveResult: true,
      openedExternalLinks: [],
      connectCalls: [],
      connectRequests: [],
      windowWorkNames: [],
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
      automationCursorPosition: "0",
      automationObserveFailures: 0,
      emitRuleOperation(markMatched = false) {
        if (!automationOperation?.actionId.endsWith(".rule"))
          throw new Error("Expected published rule");
        if (markMatched && automationOperation.state === "running") {
          automationOperation = {
            ...automationOperation,
            revision: String(BigInt(automationOperation.revision) + 1n),
            progress: { completed: "1", total: "1", unit: "matches" },
          };
        }
        return broadcastOperation(automationOperation);
      },
      emitCalendarPeer() {
        if (!automationOperation?.actionId.endsWith(".calendar"))
          throw new Error("Expected a calendar operation");
        return broadcastOperation({
          ...automationOperation,
          operationId: "fixture-calendar-peer",
          rootOperationId: "fixture-calendar-peer",
        });
      },
      calendarCheckHeld: false,
      releaseCalendarCheck() {
        if (!releaseCalendarCheck)
          throw new Error("Expected calendar preflight");
        releaseCalendarCheck();
      },
      automationRuleReplyHeld: null,
      releaseAutomationRuleReply() {
        if (!releaseRuleReply) throw new Error("Expected a held rule reply");
        releaseRuleReply();
      },
      finishRuleNotification() {
        if (
          automationOperation?.state !== "running" ||
          !automationOperation.actionId.endsWith(".rule")
        )
          throw new Error("Expected an armed rule");
        automationOperation = {
          ...automationOperation,
          revision: "2",
          state: "succeeded",
          result: {
            kind: "reference",
            value: {
              resultRef: {
                kind: "plugin_result",
                id: automationOperation.operationId,
                hostId: automationOperation.executionHostId,
                revision: "1",
              },
            },
          },
        };
      },
      automationCancelReplyHeld: false,
      releaseAutomationCancelReply() {
        if (!releaseCancellationReply)
          throw new Error("No delayed cancellation response");
        releaseCancellationReply();
      },
      finishAutomationCancellation() {
        if (automationOperation?.state !== "cancel_requested")
          throw new Error("Expected accepted automation cancellation");
        automationOperation = {
          ...automationOperation,
          revision: "3",
          state: "cancelled",
          error: {
            code: "CANCELLED",
            message: "The task was cancelled",
            retryable: false,
          },
        };
      },
      releaseDefinitionRead() {
        releaseDefinitionRead?.();
        releaseDefinitionRead = undefined;
      },
      holdNextFraming() {
        holdFraming = true;
      },
      setFramingResult(page) {
        nextFramingResult = page;
      },
      settleFramingCancellation() {
        if (framingOperation?.state !== "cancel_requested")
          throw new Error("Framing cancellation has not been requested");
        framingOperation = {
          ...framingOperation,
          state: "cancelled",
          settledAt: sentOperation.settledAt,
        };
      },
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
          workspaces: [...workspaceDocuments.values()],
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
        unregisterListener: (_event: string, id: number) => {
          catalogListeners.delete(id);
          dropListeners.delete(id);
          return callbacks.delete(id);
        },
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
              if (
                args.event === "app://host-catalog-changed" &&
                typeof args.handler === "number"
              )
                catalogListeners.add(args.handler);
              if (
                args.event === "app://transfer-file-drop" &&
                typeof args.handler === "number"
              )
                dropListeners.add(args.handler);
              return args.handler;
            case "plugin:event|unlisten":
            case "host_delivery_ack":
            case "plugin:notification|register_listener":
            case "plugin:notification|remove_listener":
            case "complete_frontend_startup":
            case "save_workspace_route":
              return null;
            case "host_save_chart_svg":
              if (
                typeof args.generation !== "string" ||
                typeof args.operationId !== "string" ||
                args.operationId !== framingOperation?.operationId ||
                framingOperation.state !== "succeeded"
              )
                throw new Error("Invalid settled chart artifact");
              fixture.chartArtifactSaves.push({
                generation: args.generation,
                operationId: args.operationId,
              });
              return fixture.chartArtifactSaveResult;
            case "save_text_export":
              if (
                typeof args.name !== "string" ||
                typeof args.content !== "string"
              )
                throw new Error("Invalid text export arguments");
              fixture.savedTextExports.push({
                name: args.name,
                content: args.content,
              });
              return args.name;
            case "set_window_work_state":
              fixture.windowWorkNames = Array.isArray(args.names)
                ? args.names.filter(
                    (name): name is string => typeof name === "string",
                  )
                : [];
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
              if (remoteAttachment) return remoteAttachment;
            // falls through to the local attachment when there is no selected route
            case "host_local_attachment":
              fixture.attachmentCalls++;
              if (hostAvailability === "pending")
                await new Promise<void>((resolve) => hostWaiters.push(resolve));
              if (hostAvailability === "failed") throw startupFailure;
              return hostAttachment;
            case "host_select_lan_route": {
              const route = args.route as LanRoute | null;
              const generation = args.generation as string | null;
              fixture.lanSwitches.push({ generation, route });
              if (
                generation !== (remoteAttachment ?? hostAttachment).generation
              )
                throw {
                  code: "EPOCH_MISMATCH",
                  message: "Stale connection",
                  retryable: false,
                };
              if (!route) {
                remoteAttachment = undefined;
                return hostAttachment;
              }
              if (
                !lanOwner ||
                route.hostId !== lanOwner.hostId ||
                route.address !== lanOwner.address
              )
                throw {
                  code: "LAN_UNAVAILABLE",
                  message: "Cannot connect",
                  retryable: true,
                };
              remoteAttachment = {
                generation: String(++remoteGeneration),
                lanRoute: route,
                attachment: {
                  ...hostAttachment.attachment,
                  hostId: route.hostId,
                },
              };
              return remoteAttachment;
            }
            case "host_browser_access": {
              if (args.generation !== hostAttachment.generation)
                throw {
                  code: "EPOCH_MISMATCH",
                  message: "Stale connection",
                  retryable: false,
                };
              const intent = args.intent as LocalBrowserAccess;
              if (intent.kind === "pair") {
                const url = "http://127.0.0.1:9240";
                browserAccess = { kind: "enabled", url, mode: intent.mode };
                return {
                  kind: "pairing",
                  mode: intent.mode,
                  entry: {
                    url,
                    pairingCode: "a".repeat(43),
                    clientId: "browser-hidden-fixture",
                  },
                } satisfies BrowserAccessState;
              }
              if (intent.kind === "revoke")
                browserAccess = { kind: "disabled" };
              return browserAccess;
            }
            case "plugin:clipboard-manager|write_text":
              fixture.copiedLanInfo.push(String(args.text));
              return null;
            case "plugin:opener|open_url":
              fixture.openedExternalLinks.push(String(args.url));
              return null;
            case "host_lan_access": {
              if (args.generation !== hostAttachment.generation)
                throw {
                  code: "EPOCH_MISMATCH",
                  message: "Stale connection",
                  retryable: false,
                };
              const action = args.params as LanAccessParams;
              fixture.lanCommands.push(action);
              if (action.kind === "enable")
                lanAccess = {
                  ...lanAccess,
                  listener: { kind: "listening", address: action.address },
                };
              if (action.kind === "disable")
                lanAccess = { ...lanAccess, listener: { kind: "disabled" } };
              if (action.kind === "setShares" || action.kind === "unpair") {
                const peers = lanAccess.peers.filter(
                  ({ peer }) => peer.hostId !== action.peer.hostId,
                );
                if (action.kind === "setShares")
                  peers.push({ peer: action.peer, shares: action.shares });
                lanAccess = { ...lanAccess, peers };
              }
              return lanAccess;
            }
            case "host_decide_browser_takeover": {
              if (
                !pendingTakeover ||
                args.generation !== hostAttachment.generation ||
                args.takeoverId !== pendingTakeover.takeoverId ||
                typeof args.approve !== "boolean"
              )
                throw new Error("Invalid browser takeover decision");
              fixture.browserTakeoverDecisions.push({
                takeoverId: pendingTakeover.takeoverId,
                approve: args.approve,
              });
              return null;
            }
            case "claim_transfer_drop":
              if (
                args.generation !== hostAttachment.generation ||
                args.ticket !== "91"
              )
                throw new Error("Invalid drop claim");
              fixture.transferDropClaims.push(args.ticket);
              return transferSource ?? null;
            case "choose_file_resource": {
              fixture.filePickerCalls.push({
                role: String(args.role),
                generation: String(args.generation),
                captureNameHint: args.captureNameHint as CaptureNameHint | null,
              });
              if (args.role === "captureSource" && peerOperation)
                return {
                  reference: { ...peerOperation.target, revision: "1" },
                  name: "comparison.swbc",
                  length: "64",
                  mime: "application/octet-stream",
                };
              if (args.role === "captureTarget" && captureTarget)
                return captureTarget;
              if (args.role === "protocolDefinitionSource" && definitionFiles) {
                chosenDefinition = definitionFiles.shift();
                return chosenDefinition?.selected ?? null;
              }
              if (args.role === "source" && transferSource)
                return transferSource;
              if (args.role === "source" && plugin) return plugin.archive;
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
            case "host_apply_node_intent": {
              if (!plugin) break;
              const intent = args.intent as LocalNodeIntent;
              fixture.pluginIntents.push(intent);
              if (intent.kind === "install" && fixture.pluginInstallFailure)
                throw {
                  code: "INVALID_ARGUMENT",
                  message: plugin.installation.archiveSha256,
                  retryable: false,
                };
              if (intent.expectedRevision !== String(pluginRevision))
                throw new Error("Unexpected plugin revision");
              const { archiveSha256 } = plugin.installation;
              if (intent.kind === "install") {
                pluginSummary = summarizePlugin({
                  ...plugin.installation,
                  enabled: false,
                  executionTrust: null,
                });
              } else {
                if (
                  !pluginSummary ||
                  !("archiveSha256" in intent.params) ||
                  intent.params.archiveSha256 !== archiveSha256
                )
                  throw new Error("Unexpected plugin archive");
                if (intent.kind === "confirmExecutionTrust")
                  pluginSummary.executionApproved = true;
                if (intent.kind === "setEnabled")
                  pluginSummary.enabled = intent.params.enabled;
                if (intent.kind === "revokeExecutionTrust") {
                  pluginSummary.executionApproved = false;
                  pluginSummary.enabled = false;
                }
              }
              const revision = String(++pluginRevision);
              const operationId = "fixture-plugin-operation-" + revision;
              const hostId = sentOperation.executionHostId;
              return {
                ...sentOperation,
                state: "succeeded",
                operationId,
                rootOperationId: operationId,
                actionId: "node.packages." + intent.kind,
                target: { kind: "host", hostId, id: hostId },
                result: {
                  kind:
                    intent.kind === "install"
                      ? "node_package_installed"
                      : "node_package_changed",
                  value: { revision, package: pluginSummary },
                },
              };
            }
            case "host_apply_document_intent": {
              const intent = args.intent as {
                kind: string;
                expectedRevision: string;
                params: { value: SharedSettings | WorkspaceDocument };
                workspaceId?: string;
              };
              if (intent.kind === "workspaceSave") {
                const workspaceId =
                  intent.workspaceId ?? workspaceState.scope.target.id;
                const base = workspaceDocuments.get(workspaceId) ?? {
                  scope: {
                    scopeId: `workspace:${workspaceId}`,
                    target: {
                      ...workspaceState.scope.target,
                      id: workspaceId,
                    },
                  },
                  document: {
                    revision: "0",
                    value: intent.params.value as WorkspaceDocument,
                  },
                };
                if (intent.expectedRevision !== base.document.revision)
                  throw { code: "CONFLICT" };
                const value = intent.params.value as WorkspaceDocument;
                if (base.document.value.archived)
                  throw { code: "WORKSPACE_DELETED" };
                if (value.archived && workspaceId === "default")
                  throw { code: "INVALID_ARGUMENT" };
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
              fixture.connectRequests.push({
                deviceId: String(args.deviceId),
                params: args.params,
              });
              if (connectFailure) throw connectFailure;
              return secondSession?.deviceId === args.deviceId
                ? secondSession
                : openedSession;
            case "host_raw_request":
            case "host_request": {
              const request = args.request as RpcRequest;
              if (
                remoteAttachment &&
                args.generation === remoteAttachment.generation &&
                request.method === "action.query" &&
                request.params.actionId !== "stream.credit"
              ) {
                const query = request.params;
                fixture.hostQueries.push(query.actionId);
                if (
                  query.actionId === "session.get" &&
                  secondSession?.sessionId === query.target.id
                )
                  return {
                    ok: true,
                    result: { kind: "session", value: secondSession },
                  };
                fixture.queryInputs.push(query);
                switch (query.actionId) {
                  case "catalog.list":
                    return {
                      ok: true,
                      result: hostQueryResults["catalog.list"],
                    };
                  case "device.list":
                    return {
                      ok: true,
                      result: {
                        kind: "devices",
                        value: { devices: [sharedDevice], stale: false },
                      },
                    };
                  case "state.scopes":
                    return {
                      ok: true,
                      result: {
                        kind: "scopes",
                        value: { scopes: [sharedScope, sharedActivityScope] },
                      },
                    };
                  case "state.snapshot":
                    if (query.params.scopeId === sharedActivityScope.scopeId) {
                      const { hostId, instanceEpoch } =
                        remoteAttachment.attachment;
                      const revision = String(sharedActivityRevision);
                      return {
                        ok: true,
                        result: {
                          kind: "snapshot",
                          value: {
                            hostId,
                            instanceEpoch,
                            revision,
                            state: sharedActivity,
                            cursor: {
                              hostId,
                              instanceEpoch,
                              scopeId: sharedActivityScope.scopeId,
                              position: revision,
                            },
                          },
                        },
                      };
                    }
                    if (query.params.scopeId === sharedScope.scopeId) {
                      const { hostId, instanceEpoch } =
                        remoteAttachment.attachment;
                      return {
                        ok: true,
                        result: {
                          kind: "snapshot",
                          value: {
                            hostId,
                            instanceEpoch,
                            revision: sharedSession.revision,
                            cursor: {
                              hostId,
                              instanceEpoch,
                              scopeId: sharedScope.scopeId,
                              position: "0",
                            },
                            state: sharedSession,
                          },
                        },
                      };
                    }
                    break;
                  case "stream.cursor":
                    if (query.target.id === sharedSession.sessionId)
                      return {
                        ok: true,
                        result: {
                          kind: "stream_cursor",
                          value: {
                            target: query.target,
                            cursor: {
                              hostId: remoteAttachment.attachment.hostId,
                              instanceEpoch:
                                remoteAttachment.attachment.instanceEpoch,
                              scopeId: "raw:shared-session:1",
                              position: "0",
                            },
                          },
                        },
                      };
                    break;
                  case "stream.read":
                    if (query.target.id === sharedSession.sessionId)
                      return {
                        ok: true,
                        result: {
                          kind: "stream_read",
                          value: {
                            events: [],
                            nextEventSeq: "1",
                            hasMore: false,
                          },
                        },
                      };
                    break;
                }
                return {
                  ok: false,
                  error: {
                    code: "PERMISSION_DENIED",
                    message: "Unavailable for shared serial",
                    retryable: false,
                  },
                };
              }
              if (request.method === "action.invoke")
                fixture.invocations.push(request.params);
              if (transferSource && request.method === "action.invoke") {
                const call = request.params;
                if (call.actionId === "transfer.file") {
                  sourceRead = "0";
                  transferOperation = {
                    ...sentOperation,
                    operationId: "fixture-file-transfer",
                    rootOperationId: "fixture-file-transfer",
                    actionId: call.actionId,
                    target: call.target,
                    requestId: call.requestId,
                    executionMode: call.executionMode ?? "independent",
                    state: "running",
                    settledAt: undefined,
                    result: {
                      kind: "file_transfer",
                      value: {
                        requested: String(call.params.length),
                        accepted: "0",
                        unknown: "0",
                        peerAcknowledged: false,
                        receiptsRef: {
                          hostId: call.target.hostId,
                          kind: "transfer_receipts",
                          id: "fixture-file-transfer-receipts",
                        },
                      },
                    },
                  };
                  return { ok: true, result: { operation: transferOperation } };
                }
                if (
                  call.actionId === "operation.cancel" &&
                  transferOperation?.operationId === call.target.id
                ) {
                  fixture.setTransferProgress(
                    transferOperation.result?.kind === "file_transfer"
                      ? transferOperation.result.value.accepted
                      : "0",
                    transferOperation.result?.kind === "file_transfer"
                      ? transferOperation.result.value.unknown
                      : "0",
                    "cancel_requested",
                  );
                  return {
                    ok: true,
                    result: {
                      operation: {
                        ...sentOperation,
                        operationId: "fixture-file-cancel",
                        rootOperationId: "fixture-file-cancel",
                        actionId: call.actionId,
                        target: call.target,
                        requestId: call.requestId,
                        executionMode: call.executionMode ?? "independent",
                        result: {
                          kind: "cancellation_requested",
                          value: {
                            operationId: call.target.id,
                            state: "cancel_requested",
                          },
                        },
                      },
                    },
                  };
                }
              }

              if (
                peerOperation &&
                request.method === "action.invoke" &&
                request.params.actionId === "replay.open" &&
                request.params.target.id === peerOperation.target.id
              )
                return {
                  ok: true,
                  result: {
                    operation: {
                      ...peerOperation,
                      requestId: request.params.requestId,
                    },
                  },
                };
              if (
                framing &&
                nextFramingResult &&
                request.method === "action.invoke" &&
                request.params.actionId === framing.action.actionId
              ) {
                const held = holdFraming;
                holdFraming = false;
                const page = nextFramingResult;
                const operationId = held
                  ? "held-framing-operation"
                  : page.fileRef.id;
                if (!held) framingResults.set(operationId, page);
                framingOperation = {
                  ...sentOperation,
                  operationId,
                  rootOperationId: operationId,
                  actionId: framing.action.actionId,
                  dependencies: framing.dependencies,
                  target: request.params.target,
                  executionMode: request.params.executionMode ?? "independent",
                  requestId: request.params.requestId,
                  state: held ? "running" : sentOperation.state,
                  settledAt: held ? undefined : sentOperation.settledAt,
                  result: held
                    ? undefined
                    : {
                        kind: "reference",
                        value: { resultRef: page.fileRef },
                      },
                };
                return {
                  ok: true,
                  result: {
                    operation: {
                      ...framingOperation,
                      state: "queued",
                      result: undefined,
                    },
                  },
                };
              }
              if (
                automation &&
                request.method === "action.invoke" &&
                request.params.actionId === automation.action.actionId
              ) {
                const call = request.params;
                const sequence = call.actionId.endsWith(".sequence");
                const rule = call.actionId.endsWith(".rule");
                const calendar = call.actionId.endsWith(".calendar");
                const loopback = call.actionId.endsWith(".loopback");
                const connection = call.actionId.endsWith(".connect");
                const waitingToArm =
                  calendar && automation.calendarInitiallyQueued;
                const retry = sequence && automation.sequenceRetry;
                const suite = sequence
                  ? automation.sequenceSuiteOutcomes
                  : undefined;
                const failed = suite?.[suiteCase] === "failed";
                const written = suite?.[suiteCase] === "written";
                const count = connection
                  ? (automation.connectionReport?.steps.length ?? 1)
                  : rule
                    ? 1
                    : sequence
                      ? retry || suite
                        ? 1
                        : 4
                      : calendar
                        ? (call.params.count ?? 1)
                        : call.params.count;
                if (typeof count !== "number")
                  throw new Error("Expected automation count");
                const id = suite
                  ? "suite-case-" + ++suiteCase
                  : sequence
                    ? "fixture-sequence"
                    : rule
                      ? ++ruleRuns === 1
                        ? "fixture-rule"
                        : "fixture-rule-" + ruleRuns
                      : calendar
                        ? ++calendarRuns === 1
                          ? "fixture-calendar"
                          : "fixture-calendar-" + calendarRuns
                        : loopback
                          ? "fixture-loopback"
                          : connection
                            ? "fixture-connection-sequence"
                            : "fixture-repeat";
                const resultRef = {
                  hostId: call.target.hostId,
                  kind: "plugin_result",
                  id,
                  revision: "1",
                };
                automationOperation = {
                  ...sentOperation,
                  operationId: id,
                  rootOperationId: id,
                  actionId: call.actionId,
                  target: call.target,
                  requestId: call.requestId,
                  executionMode: call.executionMode ?? "independent",
                  state: waitingToArm
                    ? "queued"
                    : automation.state === "held"
                      ? "running"
                      : "succeeded",
                  progress: waitingToArm
                    ? undefined
                    : {
                        completed:
                          rule && automation.state === "held" ? "0" : "1",
                        total: String(count),
                        unit: calendar
                          ? "slots"
                          : rule
                            ? "matches"
                            : sequence || connection
                              ? "steps"
                              : loopback
                                ? "frames"
                                : "rounds",
                      },
                  result:
                    automation.state === "held"
                      ? undefined
                      : { kind: "reference", value: { resultRef } },
                };
                automationFile = JSON.stringify(
                  sequence
                    ? {
                        outcome: "completed",
                        completedSteps: count,
                        attempts: [
                          ...(retry
                            ? [
                                {
                                  path: "$.steps[0]",
                                  operationId: "sequence-tx-1",
                                  outcome: "response_timeout",
                                },
                              ]
                            : []),
                          {
                            path: retry
                              ? "$.steps[0].expect.retry[0]"
                              : "$.steps[0]",
                            operationId: retry
                              ? "sequence-tx-2"
                              : "sequence-tx-1",
                            outcome: "matched",
                            source: {
                              hostId: call.target.hostId,
                              sessionId: call.target.sessionId,
                              sessionEpoch: call.target.sessionEpoch,
                              direction: "rx",
                              eventStart: "44",
                              eventEnd: "45",
                              byteStart: "0",
                              byteEnd: "1",
                            },
                          },
                          ...(!retry
                            ? [
                                {
                                  path: "$.steps[0].expect.onMatch[0]",
                                  operationId: "sequence-tx-2",
                                  outcome: "written",
                                },
                              ]
                            : []),
                        ],
                      }
                    : {
                        outcome: "completed",
                        completed: count,
                        skippedSlots: 0,
                        attempted: Array.from(
                          { length: count },
                          (_, index) => ({
                            operationId: "repeat-tx-" + (index + 1),
                            outcome: "matched",
                            scheduledMs: index * 250,
                            startedMs: index * 250,
                          }),
                        ),
                      },
                );
                if (connection && automation.connectionReport)
                  automationFile = JSON.stringify(automation.connectionReport);
                if (loopback) {
                  const size = Number(call.params.frameBytes);
                  automationFile = JSON.stringify({
                    outcome: "completed",
                    source: call.params.source,
                    sentBytes: count * size,
                    comparedBits: count * (size - 16) * 8,
                    bitErrors: 0,
                    bitErrorRate: 0,
                    throughputBytesPerSecond: 12800,
                    latencyNs: { min: 5000000, max: 5000000, mean: 5000000 },
                    frames: [
                      {
                        sequence: 1,
                        operationId: "loopback-tx-1",
                        outcome: "compared",
                        receivedBytes: size,
                        source: {
                          ...call.target,
                          direction: "rx",
                          byteStart: "10",
                          byteEnd: String(10 + size),
                        },
                      },
                    ],
                  });
                }
                if (calendar) {
                  const schedule = call.params.schedule;
                  const at =
                    schedule && typeof schedule === "object" && "at" in schedule
                      ? schedule.at
                      : call.params.endAt;
                  if (typeof at !== "string")
                    throw new Error("Expected calendar date");
                  const scheduledMs = Date.parse(at);
                  automationFile = JSON.stringify({
                    outcome: "completed",
                    runs: [
                      {
                        operationId: "calendar-tx-1",
                        outcome: "written",
                        scheduledMs,
                        observedMs: scheduledMs,
                      },
                    ],
                    skipped: [],
                  });
                }
                if (rule) {
                  automationFile = JSON.stringify({
                    outcome: "notification",
                    message: "Bench alert received",
                    source: {
                      hostId: call.target.hostId,
                      sessionId: call.target.sessionId,
                      sessionEpoch: call.target.sessionEpoch,
                      direction: "rx",
                      eventStart: "44",
                      eventEnd: "45",
                      byteStart: "2",
                      byteEnd: "8",
                    },
                  });
                }
                if (suite) {
                  fixture.automationCursorPosition = String(
                    BigInt(fixture.automationCursorPosition) + 4n,
                  );
                  automationFile = JSON.stringify({
                    outcome: failed ? "response_timeout" : "completed",
                    completedSteps: failed ? 0 : 1,
                    ...(failed && { stoppedAt: "$.steps[0]" }),
                    attempts: [
                      {
                        path: "$.steps[0]",
                        operationId: id + "-tx",
                        outcome: failed
                          ? "response_timeout"
                          : written
                            ? "written"
                            : "matched",
                        ...(!failed &&
                          !written && {
                            source: {
                              hostId: call.target.hostId,
                              sessionId: call.target.sessionId,
                              sessionEpoch: call.target.sessionEpoch,
                              direction: "rx",
                              eventStart: "2",
                              eventEnd: "3",
                              byteStart: "0",
                              byteEnd: "1",
                            },
                          }),
                      },
                    ],
                  });
                }
                if (rule) await holdRuleReply("admission");
                return {
                  ok: true,
                  result: {
                    operation:
                      automation.state === "held"
                        ? automationOperation
                        : {
                            ...automationOperation,
                            state: "queued",
                            result: undefined,
                          },
                  },
                };
              }
              if (
                automationOperation?.state === "running" &&
                request.method === "action.invoke" &&
                request.params.actionId === "operation.cancel" &&
                request.params.target.id === automationOperation.operationId
              ) {
                automationOperation = {
                  ...automationOperation,
                  revision: "2",
                  state: "cancel_requested",
                };
                if (delayedCancellationReply) {
                  delayedCancellationReply = false;
                  fixture.automationCancelReplyHeld = true;
                  await new Promise<void>((resolve) => {
                    releaseCancellationReply = resolve;
                  });
                  releaseCancellationReply = undefined;
                  fixture.automationCancelReplyHeld = false;
                  return {
                    ok: false,
                    error: {
                      code: "HOST_UNAVAILABLE",
                      message: "Late cancellation response",
                      retryable: false,
                    },
                  };
                }
                return {
                  ok: true,
                  result: {
                    operation: {
                      ...sentOperation,
                      operationId: "repeat-cancel",
                      rootOperationId: "repeat-cancel",
                      actionId: request.params.actionId,
                      target: request.params.target,
                      requestId: request.params.requestId,
                      executionMode:
                        request.params.executionMode ?? "independent",
                      result: {
                        kind: "cancellation_requested",
                        value: {
                          operationId: automationOperation.operationId,
                          state: "cancel_requested",
                        },
                      },
                    },
                  },
                };
              }
              if (
                framingOperation?.state === "running" &&
                request.method === "action.invoke" &&
                request.params.actionId === "operation.cancel" &&
                request.params.target.id === framingOperation.operationId
              ) {
                framingOperation = {
                  ...framingOperation,
                  state: "cancel_requested",
                };
                const cancellation: Operation = {
                  ...sentOperation,
                  operationId: "fixture-framing-cancellation",
                  rootOperationId: "fixture-framing-cancellation",
                  actionId: request.params.actionId,
                  target: request.params.target,
                  requestId: request.params.requestId,
                  result: {
                    kind: "cancellation_requested",
                    value: {
                      operationId: framingOperation.operationId,
                      state: "cancel_requested",
                    },
                  },
                };
                return { ok: true, result: { operation: cancellation } };
              }
              if (
                replayPlayback &&
                request.method === "action.invoke" &&
                request.params.actionId === "replay.control"
              ) {
                const call = request.params;
                const params = call.params;
                if (
                  command !== "host_request" ||
                  args.generation !== hostAttachment.generation ||
                  !validReplayTarget(call.target) ||
                  params.sessionId !== replayScope?.target.sessionId ||
                  params.sessionEpoch !== replayScope?.target.sessionEpoch ||
                  typeof params.paused !== "boolean" ||
                  params.reportPlayback !== undefined ||
                  (params.seekRecord !== undefined &&
                    typeof params.seekRecord !== "string")
                )
                  throw new Error(
                    "Invalid explicit replay.control transport or target",
                  );
                const update = params.playback;
                if (update === undefined) {
                  if (params.seekRecord !== undefined) {
                    const seek =
                      replayProfile?.page.records.findIndex(
                        (record) => replayOrdinal(record) === params.seekRecord,
                      ) ?? -1;
                    if (seek < 0) throw new Error("Unknown replay seek");
                    replayReadIndex = seek;
                    replayReaderGeneration = (
                      BigInt(replayReaderGeneration) + 1n
                    ).toString();
                  }
                  replayPlayback = { ...replayPlayback, paused: params.paused };
                } else if (
                  update &&
                  typeof update === "object" &&
                  !Array.isArray(update)
                ) {
                  if (update.kind === "set_rate") {
                    const rate = update.rate;
                    if (
                      !rate ||
                      typeof rate !== "object" ||
                      Array.isArray(rate)
                    )
                      throw new Error("Invalid replay speed");
                    if (rate.kind === "fastest") {
                      replayPlayback = {
                        ...replayPlayback,
                        rate: { kind: "fastest" },
                      };
                    } else if (
                      rate.kind === "timed" &&
                      typeof rate.speedPercent === "number"
                    ) {
                      replayPlayback = {
                        ...replayPlayback,
                        rate: {
                          kind: "timed",
                          speedPercent: rate.speedPercent,
                        },
                      };
                    } else {
                      throw new Error("Invalid replay speed");
                    }
                  } else if (update.kind === "set_breakpoint") {
                    const { breakpointRecord: _oldBreakpoint, ...previous } =
                      replayPlayback;
                    replayPlayback = {
                      ...previous,
                      ...(typeof update.record === "string"
                        ? { breakpointRecord: update.record }
                        : {}),
                      breakpointHit: false,
                    };
                  } else {
                    throw new Error("Invalid replay playback control");
                  }
                } else {
                  throw new Error("Invalid replay playback control");
                }
                const operationId = `fixture-replay-control-${replayControls.size + 1}`;
                const { result: _sendResult, ...initial } = sentOperation;
                const queued: Operation = {
                  ...initial,
                  operationId,
                  rootOperationId: operationId,
                  requestId: call.requestId,
                  actionId: call.actionId,
                  target: call.target,
                  executionMode: call.executionMode ?? "interactive",
                  state: "queued",
                };
                replayControls.set(operationId, {
                  ...queued,
                  state: "succeeded",
                  revision: "2",
                  result: { kind: "replay_position", value: replayPosition() },
                });
                return { ok: true, result: { operation: queued } };
              }
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
                request.params.actionId === "transfer.paste"
              ) {
                const call = request.params;
                const bytes = call.params.bytesBase64;
                if (typeof bytes !== "string")
                  throw new Error("Expected paste bytes");
                const length = String(atob(bytes).length);
                const operationId = `ui-paste-${call.requestId}`;
                return {
                  ok: true,
                  result: {
                    operation: {
                      ...sentOperation,
                      operationId,
                      actionId: call.actionId,
                      target: call.target,
                      requestId: call.requestId,
                      executionMode: "independent",
                      result: {
                        kind: "file_transfer",
                        value: {
                          requested: length,
                          accepted: length,
                          unknown: "0",
                          receiptsRef: {
                            hostId: call.target.hostId,
                            kind: "transfer_receipts",
                            id: operationId,
                            revision: "1",
                          },
                          peerAcknowledged: false,
                        },
                      },
                    },
                  },
                };
              }
              if (
                request.method === "action.invoke" &&
                request.params.actionId === "session.tx"
              ) {
                const bytesBase64 = request.params.params.bytesBase64;
                if (typeof bytesBase64 !== "string")
                  throw new Error("Expected TX bytes");
                const length = atob(bytesBase64).length;
                if (length === 0 || length > txMaxBytes)
                  return {
                    ok: false,
                    error: {
                      code: "INVALID_ARGUMENT",
                      message: "TX byte limit exceeded",
                      retryable: false,
                    },
                  };
                if (manualSendReceipts) {
                  const { target, requestId, expectedRevision, executionMode } =
                    request.params;
                  if (expectedRevision !== fixture.manualSendRevision)
                    return {
                      ok: false,
                      error: {
                        code: "REVISION_CONFLICT",
                        message: "Session revision changed",
                        retryable: false,
                      },
                    };
                  if (!target.sessionId || !target.sessionEpoch)
                    throw new Error("Missing manual session identity");
                  fixture.sentBytes.push(bytesBase64);
                  const operationId = "manual-tx-" + fixture.sentBytes.length;
                  const end = fixture.sentBytes.reduce(
                    (offset, chunk) => offset + atob(chunk).length,
                    0,
                  );
                  const start = String(end - length);
                  const limit = String(end);
                  const accepted = fixture.manualSendAcceptedBytes ?? length;
                  const operation: Operation = {
                    ...sentOperation,
                    target,
                    requestId,
                    executionMode: executionMode ?? sentOperation.executionMode,
                    operationId,
                    rootOperationId: operationId,
                    result: {
                      kind: "tx",
                      value: {
                        operationId,
                        sessionId: target.sessionId,
                        sessionEpoch: target.sessionEpoch,
                        bytesBase64,
                        byteStart: start,
                        byteEnd: limit,
                        acceptedRanges: accepted
                          ? [{ start: "0", end: String(accepted) }]
                          : [],
                        unknownRanges: [],
                        outcome:
                          accepted === length
                            ? "accepted"
                            : accepted === 0
                              ? "rejected"
                              : "partial",
                        peerAcknowledged: false,
                        ...(accepted < length && {
                          backendError: {
                            code: "PARTIAL_WRITE",
                            message: "The fixture backend accepted a prefix",
                            retryable: false,
                          },
                        }),
                      },
                    },
                  };
                  return { ok: true, result: { operation } };
                }
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
              if (Object.hasOwn(extensionQueryResults, query.actionId))
                return {
                  ok: true,
                  result: extensionQueryResults[query.actionId],
                };
              if (
                query.actionId === "workspace.experiment.export" &&
                Array.isArray(query.params.recordings) &&
                query.params.recordings.length > 0 &&
                !experimentRecordingReadable
              )
                return {
                  ok: false,
                  error: {
                    code: "PERMISSION_DENIED",
                    message: "Recording grant was revoked",
                    retryable: false,
                  },
                };
              if (
                sendHistory &&
                query.params.operationId === sentOperation.operationId
              ) {
                if (!fixture.sendHistoryReadable)
                  return {
                    ok: false,
                    error: {
                      code: "PERMISSION_DENIED",
                      message: "History permission revoked",
                      retryable: false,
                    },
                  };
                if (query.actionId === "operation.input") {
                  if (
                    command !== "host_raw_request" ||
                    query.target.kind !== "host" ||
                    query.target.id !== hostAttachment.attachment.hostId
                  )
                    throw new Error("Invalid send history input query");
                  return {
                    ok: true,
                    result: {
                      kind: "operation_input",
                      value: {
                        kind: "tx",
                        value: {
                          bytesBase64: "U1RBVFVTPw==",
                          writeWaitMs: "100",
                        },
                      },
                    },
                  };
                }
                if (query.actionId === "operation.get")
                  return {
                    ok: true,
                    result: {
                      kind: "operation",
                      value: { operation: sentOperation },
                    },
                  };
              }
              if (
                automation &&
                query.actionId === "session.get" &&
                query.target.id === openedSession.sessionId
              )
                return {
                  ok: true,
                  result: {
                    kind: "session",
                    value: {
                      ...openedSession,
                      configurationRevision:
                        fixture.suiteConfigurationRevision ??
                        openedSession.configurationRevision,
                      revision:
                        fixture.calendarSessionRevision ??
                        openedSession.revision,
                    },
                  },
                };
              if (
                automationOperation &&
                query.actionId === "operation.get" &&
                query.params.operationId === automationOperation.operationId
              ) {
                if (fixture.automationObserveFailures > 0) {
                  fixture.automationObserveFailures--;
                  return {
                    ok: false,
                    error: {
                      code: "HOST_BUSY",
                      message: "Try querying the operation again",
                      retryable: true,
                    },
                  };
                }
                return {
                  ok: true,
                  result: {
                    kind: "operation",
                    value: { operation: automationOperation },
                  },
                };
              }
              if (
                automationOperation?.result?.kind === "reference" &&
                query.actionId === "file.read" &&
                query.target.id === automationOperation.operationId
              ) {
                const bytes = new TextEncoder().encode(automationFile);
                const digest = new Uint8Array(
                  await crypto.subtle.digest("SHA-256", bytes),
                );
                const fingerprint = Array.from(digest, (byte) =>
                  byte.toString(16).padStart(2, "0"),
                ).join("");
                return {
                  ok: true,
                  result: {
                    kind: "file_read",
                    value: {
                      fileRef: automationOperation.result.value.resultRef,
                      offset: "0",
                      nextOffset: String(bytes.length),
                      totalBytes: String(bytes.length),
                      fingerprint,
                      atEnd: true,
                      bytesBase64: btoa(automationFile),
                    },
                  },
                };
              }
              if (
                framingOperation &&
                query.actionId === "operation.get" &&
                query.params.operationId === framingOperation.operationId
              )
                return {
                  ok: true,
                  result: {
                    kind: "operation",
                    value: { operation: framingOperation },
                  },
                };
              if (
                transferSource &&
                query.actionId === "file.read" &&
                query.target.id === transferSource.reference.id
              ) {
                const bytes = [0, 0xfe, 0x23, 0xff, 1, 2, 3, 4, 5, 6];
                const offset = Number(query.params.offset);
                const limit = Number(query.params.maxBytes);
                if (
                  command !== "host_raw_request" ||
                  !Number.isSafeInteger(offset) ||
                  offset < 0 ||
                  offset >= bytes.length ||
                  !Number.isSafeInteger(limit) ||
                  limit < 1 ||
                  limit > 16
                )
                  throw new Error("Unexpected transfer sample request");
                const end = Math.min(offset + limit, bytes.length);
                return {
                  ok: true,
                  result: {
                    kind: "file_read",
                    value: {
                      fileRef: transferSource.reference,
                      offset: String(offset),
                      nextOffset: String(end),
                      totalBytes: String(bytes.length),
                      fingerprint: "a".repeat(64),
                      atEnd: end === bytes.length,
                      bytesBase64: btoa(
                        String.fromCharCode(...bytes.slice(offset, end)),
                      ),
                    },
                  },
                };
              }
              const framingResult = framingResults.get(query.target.id);
              if (framingResult && query.actionId === "file.read") {
                if (
                  command !== "host_raw_request" ||
                  query.params.offset !== "0"
                )
                  throw new Error("Frame result must start on the Raw channel");
                return {
                  ok: true,
                  result: { kind: "file_read", value: framingResult },
                };
              }
              if (
                chosenDefinition &&
                query.target.id === chosenDefinition.selected.reference.id &&
                (query.actionId === "file.read" ||
                  query.actionId === "file.metadata")
              ) {
                const { metadata, page, holdRead } = chosenDefinition;
                if (query.actionId === "file.metadata" && metadata)
                  return {
                    ok: true,
                    result: { kind: "file_metadata", value: metadata },
                  };
                if (
                  query.actionId !== "file.read" ||
                  !page ||
                  command !== "host_raw_request" ||
                  query.params.offset !== "0" ||
                  query.params.maxBytes !== page.totalBytes
                )
                  throw new Error("Unexpected definition file read");
                if (holdRead)
                  await new Promise<void>((resolve) => {
                    releaseDefinitionRead = resolve;
                  });
                return { ok: true, result: { kind: "file_read", value: page } };
              }
              if (
                fixture.limitPluginReads &&
                (query.actionId.startsWith("node.packages.") ||
                  query.actionId === "node.sources.list")
              ) {
                if (activePluginReads >= 2)
                  return {
                    ok: false,
                    error: {
                      code: "HOST_BUSY",
                      message: "Plugin read capacity is occupied",
                      retryable: true,
                    },
                  };
                activePluginReads++;
                await new Promise((resolve) => setTimeout(resolve, 50));
                activePluginReads--;
              }
              if (plugin && query.actionId === "node.packages.list")
                return {
                  ok: true,
                  result: {
                    kind: "node_packages",
                    value: {
                      revision: String(pluginRevision),
                      packages: pluginSummary ? [pluginSummary] : [],
                    },
                  },
                };
              if (plugin && query.actionId === "node.sources.list")
                return {
                  ok: true,
                  result: {
                    kind: "node_package_sources",
                    value: {
                      revision: "1",
                      keys: plugin.source ? [plugin.source] : [],
                    },
                  },
                };
              if (pluginSummary && query.actionId === "node.packages.runtime")
                return {
                  ok: true,
                  result: {
                    kind: "node_package_runtime",
                    value: {
                      id: pluginSummary.id,
                      archiveSha256: pluginSummary.archiveSha256,
                      phase: pluginSummary.enabled ? "active" : "inactive",
                      generation: "1",
                    },
                  },
                };
              if (
                plugin &&
                pluginSummary &&
                query.actionId === "node.packages.detailsRead"
              ) {
                const { archiveSha256, manifest, verifiedSource } =
                  plugin.installation;
                const bytes = new TextEncoder().encode(
                  JSON.stringify({
                    ...plugin.installation,
                    enabled: pluginSummary.enabled,
                    executionTrust: pluginSummary.executionApproved
                      ? {
                          archiveSha256,
                          verifiedSource,
                          permissions: manifest.permissions,
                        }
                      : null,
                  }),
                );
                const digest = await crypto.subtle.digest("SHA-256", bytes);
                return {
                  ok: true,
                  result: {
                    kind: "node_package_details",
                    value: {
                      revision: String(pluginRevision),
                      id: manifest.id,
                      archiveSha256,
                      offset: "0",
                      totalBytes: String(bytes.length),
                      bytesBase64: btoa(String.fromCharCode(...bytes)),
                      jsonSha256: Array.from(new Uint8Array(digest), (byte) =>
                        byte.toString(16).padStart(2, "0"),
                      ).join(""),
                    },
                  },
                };
              }
              if (
                replayPlayback &&
                query.actionId === "operation.get" &&
                typeof query.params.operationId === "string"
              ) {
                const operation = replayControls.get(query.params.operationId);
                if (operation) {
                  if (
                    command !== "host_request" ||
                    args.generation !== hostAttachment.generation ||
                    query.target.kind !== "host" ||
                    query.target.id !== hostAttachment.attachment.hostId ||
                    query.target.hostId !== hostAttachment.attachment.hostId
                  )
                    throw new Error(
                      "Invalid replay operation observation target",
                    );
                  return {
                    ok: true,
                    result: { kind: "operation", value: { operation } },
                  };
                }
              }
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
              if (
                replayPeer &&
                peerScope &&
                query.target.id === peerScope.target.id
              ) {
                if (query.actionId === "session.get")
                  return {
                    ok: true,
                    result: { kind: "session", value: replayPeer.session },
                  };
                if (query.actionId === "replay.read") {
                  if (
                    command !== "host_raw_request" ||
                    args.generation !== hostAttachment.generation ||
                    query.target.hostId !== peerScope.target.hostId ||
                    query.target.kind !== "session" ||
                    query.params.sessionId !== peerScope.target.sessionId ||
                    query.params.sessionEpoch !==
                      peerScope.target.sessionEpoch ||
                    query.params.maxRecords !== "100" ||
                    query.params.maxBytes !== "65536"
                  )
                    throw new Error("Invalid comparison replay target");
                  return {
                    ok: true,
                    result: { kind: "replay_read", value: replayPeer.page },
                  };
                }
              }
              if (
                peerOperation &&
                query.actionId === "operation.get" &&
                query.params.operationId === peerOperation.operationId
              )
                return {
                  ok: true,
                  result: {
                    kind: "operation",
                    value: { operation: peerOperation },
                  },
                };
              if (
                replayProfile?.searchPages &&
                query.actionId === "replay.search"
              ) {
                const params = query.params.command;
                if (
                  command !== "host_raw_request" ||
                  args.generation !== hostAttachment.generation ||
                  !validReplayTarget(query.target) ||
                  query.params.sessionId !== replayProfile.session.sessionId ||
                  query.params.sessionEpoch !==
                    replayProfile.session.sessionEpoch ||
                  !params ||
                  typeof params !== "object" ||
                  Array.isArray(params) ||
                  typeof params.searchId !== "string"
                )
                  throw new Error("Invalid replay search route or scope");
                if (params.kind === "stop") {
                  const stopped = replaySearchId === params.searchId;
                  if (stopped) replaySearchId = undefined;
                  return {
                    ok: true,
                    result: {
                      kind: "replay_search",
                      value: {
                        kind: "stopped",
                        searchId: params.searchId,
                        stopped,
                      },
                    },
                  };
                }
                let number = 1;
                if (params.kind === "start") replaySearchId = params.searchId;
                else if (
                  params.kind === "next" &&
                  replaySearchId === params.searchId &&
                  typeof params.page === "string"
                )
                  number = Number(params.page);
                else throw new Error("Invalid replay search cursor");
                const result = replayProfile.searchPages[number - 1];
                if (!result)
                  throw new Error("Replay search fixture page exhausted");
                return {
                  ok: true,
                  result: {
                    kind: "replay_search",
                    value: {
                      kind: "page",
                      searchId: params.searchId,
                      page: String(number),
                      result,
                    },
                  },
                };
              }
              if (replayProfile && query.actionId === "replay.read") {
                const singleStep = query.params.singleStep === true;
                const inspect = query.params.inspectPlayback === true;
                if (
                  command !== "host_raw_request" ||
                  args.generation !== hostAttachment.generation ||
                  !validReplayTarget(query.target) ||
                  query.params.maxRecords !==
                    (singleStep || inspect ? "1" : "100") ||
                  query.params.maxBytes !== "65536" ||
                  query.params.sessionId !== replayProfile.session.sessionId ||
                  query.params.sessionEpoch !==
                    replayProfile.session.sessionEpoch ||
                  (inspect
                    ? !replayPlayback ||
                      query.params.reportPlayback !== undefined ||
                      query.params.singleStep !== undefined
                    : query.params.inspectPlayback !== undefined ||
                      (replayPlayback
                        ? query.params.reportPlayback !== true
                        : singleStep ||
                          query.params.reportPlayback !== undefined))
                )
                  throw new Error(
                    "Invalid explicit replay.read transport, target or budget",
                  );
                if (!replayPlayback)
                  return {
                    ok: true,
                    result: { kind: "replay_read", value: replayProfile.page },
                  };
                if (inspect)
                  return {
                    ok: true,
                    result: { kind: "replay_read", value: playbackPage() },
                  };
                if (singleStep)
                  replayPlayback = { ...replayPlayback, paused: true };
                const records: ReplayReadResult["records"] = [];
                while (
                  replayReadIndex < replayProfile.page.records.length &&
                  (singleStep || !replayPlayback.paused) &&
                  records.length < (singleStep ? 1 : 100)
                ) {
                  const record = replayProfile.page.records[replayReadIndex]!;
                  if (
                    !singleStep &&
                    !replayPlayback.breakpointHit &&
                    replayPlayback.breakpointRecord === replayOrdinal(record)
                  ) {
                    replayPlayback = {
                      ...replayPlayback,
                      paused: true,
                      breakpointHit: true,
                    };
                    break;
                  }
                  records.push(record);
                  replayReadIndex++;
                  replayPlayback = { ...replayPlayback, breakpointHit: false };
                }
                return {
                  ok: true,
                  result: {
                    kind: "replay_read",
                    value: playbackPage(records),
                  },
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
              if (
                query.actionId === "capture.redactionPreview" &&
                captureRedactionPreview
              )
                return {
                  ok: true,
                  result: {
                    kind: "capture_redaction_preview",
                    value: captureRedactionPreview,
                  },
                };
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
              if (query.actionId === "workspace.list") {
                return {
                  ok: true,
                  result: {
                    kind: "workspaces",
                    value: {
                      workspaces: [...workspaceDocuments.values()]
                        .filter((item) => !item.document.value.archived)
                        .map((item) => ({
                          scope: item.scope,
                          name: item.document.value.name,
                          revision: item.document.revision,
                        })),
                    },
                  },
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
              if (
                transferOperation &&
                query.actionId === "operation.get" &&
                query.params.operationId === transferOperation.operationId
              )
                return {
                  ok: true,
                  result: {
                    kind: "operation",
                    value: { operation: transferOperation },
                  },
                };
              if (
                query.actionId === "transfer.readProgress" &&
                transferOperation?.result?.kind === "file_transfer"
              ) {
                const reference = transferOperation.result.value.receiptsRef;
                if (
                  query.target.id !== reference.id ||
                  query.target.kind !== reference.kind
                )
                  throw new Error("Wrong transfer receipt scope");
                return {
                  ok: true,
                  result: {
                    kind: "file_transfer_read_progress",
                    value: { receiptsRef: reference, read: sourceRead },
                  },
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
              if (query.actionId === "node.themes.list")
                return {
                  ok: true,
                  result: { kind: "node_themes", value: { themes } },
                };
              if (query.actionId === "action.check") {
                if (query.params.actionId === "session.configure") {
                  await new Promise<void>((resolve) =>
                    setTimeout(resolve, fixture.configureCheckDelayMs),
                  );
                  return {
                    ok: true,
                    result: {
                      kind: "action_check",
                      value: {
                        actionId: query.params.actionId,
                        target: query.target,
                        allowed: fixture.configureAllowed,
                      },
                    },
                  };
                }
                if (
                  query.params.actionId === "replay.read" &&
                  fixture.deniedReplayReads.includes(query.target.id)
                )
                  return {
                    ok: true,
                    result: {
                      kind: "action_check",
                      value: {
                        actionId: "replay.read",
                        target: query.target,
                        allowed: false,
                      },
                    },
                  };
                if (
                  automation &&
                  query.params.actionId === automation.action.actionId
                ) {
                  if (automation.action.actionId.endsWith(".rule"))
                    await holdRuleReply("preflight");
                  if (
                    automation.action.actionId.endsWith(".calendar") &&
                    automation.delaySecondCalendarCheck &&
                    ++calendarChecks === 2
                  ) {
                    fixture.calendarCheckHeld = true;
                    await new Promise<void>((resolve) => {
                      releaseCalendarCheck = resolve;
                    });
                    fixture.calendarCheckHeld = false;
                    releaseCalendarCheck = undefined;
                  }
                  return {
                    ok: true,
                    result: {
                      kind: "action_check",
                      value: {
                        actionId: automation.action.actionId,
                        target: query.target,
                        allowed: automation.state !== "denied",
                      },
                    },
                  };
                }
                if (
                  query.params.actionId === "operation.cancel" &&
                  automationOperation?.actionId.endsWith(".rule") &&
                  query.target.id === automationOperation.operationId
                )
                  await holdRuleReply("cancelCheck");
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
                      allowed:
                        sendHistory &&
                        (query.params.actionId === "operation.get" ||
                          query.params.actionId === "operation.input")
                          ? fixture.sendHistoryReadable
                          : !capture || tailPermission === "allow",
                    },
                  },
                };
              }
              if (query.actionId === "stream.cursor") {
                if (fixture.rawCursorGate) await fixture.rawCursorGate;
                return {
                  ok: true,
                  result: {
                    kind: "stream_cursor",
                    value: {
                      target: query.target,
                      cursor: {
                        hostId: hostAttachment.attachment.hostId,
                        instanceEpoch: "1",
                        scopeId: [".sequence", ".rule", ".loopback"].some(
                          (suffix) =>
                            automation?.action.actionId.endsWith(suffix),
                        )
                          ? (fixture.automationCursorScope ??
                            [
                              "raw",
                              query.target.sessionId,
                              query.target.sessionEpoch,
                            ].join(":"))
                          : "session.raw",
                        position: fixture.automationCursorPosition,
                      },
                    },
                  },
                };
              }
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
                if (scopeId === "host.operations" && transferSource) {
                  const { hostId, instanceEpoch } = hostAttachment.attachment;
                  return {
                    ok: true,
                    result: {
                      kind: "snapshot",
                      value: {
                        hostId,
                        instanceEpoch,
                        revision: String(operationPosition + 1),
                        cursor: {
                          hostId,
                          instanceEpoch,
                          scopeId,
                          position: String(operationPosition),
                        },
                        state: { items: [] },
                      },
                    },
                  };
                }
                if (scopeId === "host.operations" && sendHistory) {
                  const {
                    operationId,
                    executionHostId,
                    actorId,
                    actionId,
                    target,
                    executionMode,
                    state,
                    revision,
                    revealTarget,
                    acceptedAt,
                  } = sentOperation;
                  const { hostId, instanceEpoch } = hostAttachment.attachment;
                  return {
                    ok: true,
                    result: {
                      kind: "snapshot",
                      value: {
                        hostId,
                        instanceEpoch,
                        revision: "1",
                        cursor: {
                          hostId,
                          instanceEpoch,
                          scopeId,
                          position: "0",
                        },
                        state: {
                          // 重载后模拟操作已移出投影，但仍可按 ID 查询。
                          items: retained?.client.state.sendHistoryPins?.length
                            ? []
                            : [
                                {
                                  operationId,
                                  executionHostId,
                                  actorId,
                                  actionId,
                                  target,
                                  executionMode,
                                  state,
                                  revision,
                                  revealTarget,
                                  acceptedAt,
                                },
                              ],
                        },
                      },
                    },
                  };
                }
                if (scopeId === "host.activity" && pendingTakeover)
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
                        state: { items: [], pendingTakeover },
                      },
                    },
                  };
                if (
                  replayProfile &&
                  replayScope &&
                  replayOperation &&
                  typeof scopeId === "string" &&
                  (scopeId === "host.operations" ||
                    scopeId === replayScope.scopeId ||
                    scopeId === peerScope?.scopeId)
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
                            ? {
                                items: [
                                  replaySummary,
                                  ...(peerSummary ? [peerSummary] : []),
                                ],
                              }
                            : scopeId === peerScope?.scopeId && replayPeer
                              ? replayPeer.session
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
              const lifecycle = args.lifecycle;
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
                typeof channel.id !== "number" ||
                !lifecycle ||
                typeof lifecycle !== "object" ||
                !("id" in lifecycle) ||
                typeof lifecycle.id !== "number"
              )
                throw new Error("Invalid raw subscription fixture request");
              const sessionId = request.target.sessionId ?? request.target.id;
              if (fixture.deniedRawSessions.includes(sessionId)) {
                throw {
                  code: "PERMISSION_DENIED",
                  message: "Content access revoked",
                  retryable: false,
                };
              }
              const subscriptionId = `workbench-gui-subscription-${nextSubscription++}`;
              rawChannels.set(subscriptionId, {
                callback: channel.id,
                lifecycle: lifecycle.id,
                requestId: request.requestId,
                index: 0,
                lifecycleIndex: 0,
                sessionId,
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
                formatVersion: "0.1",
                collectedAt: "2026-10-28T00:00:00Z",
                appVersion,
                tauriVersion: "2.0.0",
                platform: "headless-fixture",
                architecture: "x64",
                windowLabel: "main",
                settingsRevision: currentSettings.document.revision,
                configuration: {
                  language: currentSettings.document.value.language,
                  networkMode: currentSettings.document.value.networkMode,
                  runInBackground:
                    currentSettings.document.value.runInBackground,
                },
                desktop,
                autostartEnabled: false,
                updaterConfigured: false,
                recentLogs: diagnosticLogs ?? "",
              } satisfies DiagnosticsReport;
            case "save_diagnostics_json":
              return false;
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
