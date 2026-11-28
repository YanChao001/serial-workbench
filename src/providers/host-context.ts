import { createContext, useContext } from "react";
import type { HostConnection } from "@/lib/host-client";
import type { BrowserFileProgress } from "@/lib/browser-file-transfer";
import type { ReceiveIdleMs } from "@/lib/receive-history";
import type {
  ConnectionSequenceIntent,
  LocalScriptIntent,
  ConnectionSequenceIntentResult,
  FileResourceRole,
  SelectedFileResource,
  TransferDrop,
} from "@/lib/tauri";
import type {
  Call,
  ActionCheckParams,
  ActionCheckResult,
  ActionSpec,
  ActivitySummary,
  BrowserTakeoverRequest,
  CommandLibraryChange,
  CommandLibraryReadParams,
  CommandLibraryReadResult,
  CaptureRecord,
  CaptureStatusResult,
  CaptureTailResult,
  DeviceDescriptor,
  DocumentJsonResult,
  FavoritesSaveParams,
  FileReadParams,
  FileMetadata,
  FileTransferParams,
  FileReadResult,
  FileTransferReceiptsParams,
  FileTransferReceiptsResult,
  FileTransferReadProgressParams,
  FileTransferReadProgress,
  HostMetrics,
  ObjectRef,
  OpenParams,
  Operation,
  OperationInput,
  OperationSummary,
  ScriptDebugIntent,
  ScriptDebugResult,
  RebindParams,
  RecentList,
  ReplayReadParams,
  ReplayReadResult,
  ReplayPeerState,
  ReplayTransmitPreview,
  ReplayTransmitSelection,
  ReplaySearchParams,
  ReplaySearchResult,
  ReplayRecord,
  SessionSnapshot,
  SessionMetrics,
  SessionInputs,
  TxParams,
  SerialConfiguration,
  WorkspaceDocument,
  WorkspaceDocumentResult,
  WorkspaceConfigurationExportParams,
  WorkspaceConfigurationInspection,
  WorkspaceStartupPlan,
  WorkspaceListResult,
  Target,
} from "@serial-workbench/contracts";

export type SendSourceMetadata = Required<
  Pick<TxParams, "sourceText" | "transforms">
>;

export type HostInvocation = Pick<
  Call,
  | "actionId"
  | "target"
  | "params"
  | "expectedRevision"
  | "leaseId"
  | "workspaceStartup"
> &
  Required<Pick<Call, "executionMode">>;

export type HostStreamView = {
  sourceSubscriptionId?: string;
  items: readonly import("@/lib/receive-history").HistoryStreamItem[];
  sourceItems?: readonly import("@serial-workbench/contracts").StreamItem[];
  error: Error | null;
  trimmed: boolean;
  receiveIdleMs?: ReceiveIdleMs;
  removed?: import("@/lib/receive-history").HistoryPosition;
};
export type HostActionCheckInput = ActionCheckParams & { target: Target };
export type HostActionAvailability = {
  input: HostActionCheckInput;
  result: ActionCheckResult | null;
  error: Error | null;
};
export type HostState = {
  status: "preview" | "connecting" | "ready" | "error";
  error: Error | null;
  devices: DeviceDescriptor[];
  devicesStale: boolean;
  catalog: readonly ActionSpec[];
  sessions: SessionSnapshot[];
  replaySessionEpochs?: ReadonlyMap<string, string>;
  operations: Operation[];
  operationSummaries: OperationSummary[];
  operationSummariesReady: boolean;
  activities?: readonly ActivitySummary[];
  pendingTakeover?: BrowserTakeoverRequest;
  streams: ReadonlyMap<string, HostStreamView>;
  workspace?: WorkspaceDocumentResult;
};
export type CommandBodyFileAccess =
  | { kind: "browser" }
  | (Pick<HostContextValue, "fileMetadata" | "readFile" | "pickDroppedFile"> & {
      kind: "native";
      choose(signal: AbortSignal): Promise<SelectedFileResource | null>;
    });

export type CommandLibraryAccess = {
  owner: string;
  bodyFiles?: CommandBodyFileAccess;
  files?: {
    importArchive(
      workspaceId: string,
      revision: string,
      signal: AbortSignal,
    ): Promise<boolean>;
    exportArchive(
      workspaceId: string,
      revision: string,
      signal: AbortSignal,
    ): Promise<boolean>;
  };
  open(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<CommandLibraryReadResult>;
  read(
    workspaceId: string,
    params: CommandLibraryReadParams,
    signal: AbortSignal,
  ): Promise<CommandLibraryReadResult>;
  change?(
    workspaceId: string,
    revision: string,
    change: CommandLibraryChange,
    signal: AbortSignal,
  ): Promise<string>;
};

export type HostContextValue = {
  commandLibrary?: CommandLibraryAccess;
  runConfirmedScript?(
    intent: LocalScriptIntent,
    signal: AbortSignal,
  ): Promise<Operation>;
  scriptDebug?(
    operation: Operation,
    intent: ScriptDebugIntent,
    signal: AbortSignal,
  ): Promise<ScriptDebugResult>;
  connectionSequenceIntent?(
    intent: ConnectionSequenceIntent,
    signal: AbortSignal,
  ): Promise<ConnectionSequenceIntentResult>;
  state: HostState;
  connection?: HostConnection;
  browserFile?: {
    send(
      target: Target,
      file: File,
      draft: Omit<FileTransferParams, "sourceRef">,
      report: (progress: BrowserFileProgress) => void,
      signal: AbortSignal,
    ): Promise<Operation | null>;
    recover(signal: AbortSignal): Promise<Operation | null>;
    hasPending(): boolean;
  };
  refresh(options?: { enumerateDevices?: boolean }): Promise<void>;
  metrics(signal?: AbortSignal): Promise<HostMetrics>;
  sessionMetrics(target: Target, signal?: AbortSignal): Promise<SessionMetrics>;
  sessionInputs(target: Target, signal?: AbortSignal): Promise<SessionInputs>;
  readOperationSummary?(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<OperationSummary>;
  operationInput(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<OperationInput>;
  pickFile(
    role: FileResourceRole,
    signal?: AbortSignal,
    selectedSessionId?: string,
  ): Promise<SelectedFileResource | null>;
  pickDroppedFile?(
    drop: TransferDrop,
    signal?: AbortSignal,
  ): Promise<SelectedFileResource | null>;
  trustedConnect(
    deviceId: string,
    signal?: AbortSignal,
    configuration?: SerialConfiguration,
    transportParams?: OpenParams["transportParams"],
  ): Promise<SessionSnapshot>;
  readReplayRecord(
    reference: Extract<ReplayRecord, { kind: "reference" }>,
    signal?: AbortSignal,
  ): Promise<CaptureRecord>;
  readFile(
    params: FileReadParams,
    signal?: AbortSignal,
  ): Promise<FileReadResult>;
  fileMetadata(
    reference: ObjectRef,
    signal?: AbortSignal,
  ): Promise<FileMetadata>;
  readCaptureTail(
    reference: ObjectRef,
    signal?: AbortSignal,
  ): Promise<CaptureTailResult>;
  captureStatus(
    reference: ObjectRef,
    signal?: AbortSignal,
  ): Promise<CaptureStatusResult>;
  readTransferProgress?(
    params: FileTransferReadProgressParams,
    signal?: AbortSignal,
  ): Promise<FileTransferReadProgress>;
  readFileReceipts(
    params: FileTransferReceiptsParams,
    signal?: AbortSignal,
  ): Promise<FileTransferReceiptsResult>;
  previewReplayTransmit?(
    target: Target,
    selection: ReplayTransmitSelection,
    signal: AbortSignal,
  ): Promise<ReplayTransmitPreview>;
  readReplayPeer?(
    target: Target,
    signal: AbortSignal,
  ): Promise<ReplayPeerState>;
  readReplay(
    params: ReplayReadParams,
    signal?: AbortSignal,
  ): Promise<ReplayReadResult>;
  searchReplay(
    params: ReplaySearchParams,
    signal?: AbortSignal,
  ): Promise<ReplaySearchResult>;
  loadWorkspace(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocumentResult>;
  /** 持久工作区的有界名称目录，按调用方权限过滤。 */
  listWorkspaces(
    signal?: AbortSignal,
    after?: string,
  ): Promise<WorkspaceListResult>;
  /** Explicit user gesture; resolves only with this save's successful receipt. */
  saveWorkspace(
    base: WorkspaceDocumentResult,
    value: WorkspaceDocument,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocumentResult>;
  saveFavorites(
    base: WorkspaceDocumentResult,
    params: FavoritesSaveParams,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocumentResult>;
  rebindDevice(
    base: WorkspaceDocumentResult,
    params: RebindParams,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocumentResult>;
  recentConnections(signal?: AbortSignal): Promise<RecentList>;
  exportWorkspace(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<DocumentJsonResult>;
  previewWorkspaceImport(
    workspaceId: string,
    json: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocument>;
  readWorkspaceStartupPlan?(
    base: WorkspaceDocumentResult,
    signal: AbortSignal,
  ): Promise<WorkspaceStartupPlan>;
  inspectWorkspaceConfiguration(
    workspaceId: string,
    json: string,
    signal: AbortSignal,
  ): Promise<WorkspaceConfigurationInspection>;
  importWorkspaceConfiguration(
    base: WorkspaceDocumentResult,
    preview: WorkspaceConfigurationInspection,
    json: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocumentResult>;
  exportWorkspaceConfiguration(
    workspaceId: string,
    params: WorkspaceConfigurationExportParams,
    signal: AbortSignal,
  ): Promise<DocumentJsonResult>;
  waitForOperation(
    operation: Operation,
    signal?: AbortSignal,
    until?: "running" | "succeeded",
    pollIntervalMs?: number,
  ): Promise<Operation>;
  checkAction(
    input: HostActionCheckInput,
    signal?: AbortSignal,
  ): Promise<ActionCheckResult>;
  /** UI observations only. Null result/error means unknown; invoke reauthorizes. */
  watchActions(
    inputs: readonly HostActionCheckInput[],
    listener: (values: readonly HostActionAvailability[]) => void,
  ): () => void;
  open(
    deviceId: string,
    signal?: AbortSignal,
    configuration?: SerialConfiguration,
    transportParams?: OpenParams["transportParams"],
  ): Promise<SessionSnapshot>;
  send(
    target: Target,
    bytes: Uint8Array,
    signal?: AbortSignal,
    writeWaitMs?: string,
    expectedRevision?: string,
    source?: SendSourceMetadata,
  ): Promise<Operation>;
  takeover?(
    target: Target,
    actorId: string,
    signal?: AbortSignal,
  ): Promise<Operation>;
  decideBrowserTakeover?(id: string, approve: boolean): Promise<void>;
  invoke(input: HostInvocation, signal?: AbortSignal): Promise<Operation>;
  watchSession(sessionId: string, listener: () => void): () => void;
  setReceiveIdleMs?(
    sessionId: string,
    sessionEpoch: string,
    value: ReceiveIdleMs,
  ): void;
};
export const HostContext = createContext<HostContextValue | null>(null);
export function useHost(): HostContextValue {
  const value = useContext(HostContext);
  if (!value) throw new Error("HostProvider is required");
  return value;
}
