import { createContext, useContext } from "react";
import type { HostConnection } from "@/lib/host-client";
import type { FileResourceRole, SelectedFileResource } from "@/lib/tauri";
import type {
  Call,
  ActionCheckParams,
  ActionCheckResult,
  ActionSpec,
  CaptureRecord,
  CaptureStatusResult,
  CaptureTailResult,
  DeviceDescriptor,
  DocumentJsonResult,
  FavoritesSaveParams,
  FileReadParams,
  FileMetadata,
  FileReadResult,
  FileTransferReceiptsParams,
  FileTransferReceiptsResult,
  HostMetrics,
  ObjectRef,
  Operation,
  OperationInput,
  OperationSummary,
  RebindParams,
  RecentList,
  ReplayReadParams,
  ReplayReadResult,
  ReplayRecord,
  SessionSnapshot,
  SessionMetrics,
  SessionInputs,
  SerialConfiguration,
  StreamItem,
  WorkspaceDocument,
  WorkspaceDocumentResult,
  Target,
} from "@serial-workbench/contracts";

export type HostInvocation = Pick<
  Call,
  "actionId" | "target" | "params" | "expectedRevision" | "leaseId"
> &
  Required<Pick<Call, "executionMode">>;

export type HostStreamView = {
  items: readonly StreamItem[];
  error: Error | null;
  trimmed: boolean;
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
  operations: Operation[];
  operationSummaries: OperationSummary[];
  streams: ReadonlyMap<string, HostStreamView>;
  workspace?: WorkspaceDocumentResult;
};
export type HostContextValue = {
  state: HostState;
  connection?: HostConnection;
  refresh(options?: { enumerateDevices?: boolean }): Promise<void>;
  metrics(signal?: AbortSignal): Promise<HostMetrics>;
  sessionMetrics(target: Target, signal?: AbortSignal): Promise<SessionMetrics>;
  sessionInputs(target: Target, signal?: AbortSignal): Promise<SessionInputs>;
  operationInput(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<OperationInput>;
  pickFile(
    role: FileResourceRole,
    signal?: AbortSignal,
    selectedSessionId?: string,
  ): Promise<SelectedFileResource | null>;
  trustedConnect(
    deviceId: string,
    signal?: AbortSignal,
    configuration?: SerialConfiguration,
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
  readFileReceipts(
    params: FileTransferReceiptsParams,
    signal?: AbortSignal,
  ): Promise<FileTransferReceiptsResult>;
  readReplay(
    params: ReplayReadParams,
    signal?: AbortSignal,
  ): Promise<ReplayReadResult>;
  loadWorkspace(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocumentResult>;
  /** 当前 Host 已注册且可见的 scope；重启后可能尚未读取其他持久工作区。 */
  listWorkspaces(signal?: AbortSignal): Promise<WorkspaceDocumentResult[]>;
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
  waitForOperation(
    operation: Operation,
    signal?: AbortSignal,
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
  ): Promise<SessionSnapshot>;
  send(
    sessionId: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Operation>;
  takeover(sessionId: string, signal?: AbortSignal): Promise<Operation>;
  invoke(input: HostInvocation, signal?: AbortSignal): Promise<Operation>;
  watchSession(sessionId: string, listener: () => void): () => void;
};
export const HostContext = createContext<HostContextValue | null>(null);
export function useHost(): HostContextValue {
  const value = useContext(HostContext);
  if (!value) throw new Error("HostProvider is required");
  return value;
}
