import type {
  CaptureRecord,
  ObjectRef,
  OperationsSnapshot,
  RpcReply,
  SerialConfiguration,
  SharedSettings,
  WireFrame,
  WorkspaceDocument,
} from "./generated/types.ts";
import {
  validateCaptureRecord,
  validateObjectRef,
  validateOperationsSnapshot,
  validateRpcReply,
  validateSerialConfiguration,
  validateSharedSettings,
  validateWireFrame,
  validateWorkspaceDocument,
} from "./generated/validators.mjs";
import generatedDefaults from "./generated/defaults.json";

export type * from "./generated/types.ts";

export class ContractValidationError extends Error {
  constructor(message = "Invalid Host RPC reply") {
    super(message);
    this.name = "ContractValidationError";
  }
}

const { settings, workspace, serialConfiguration } = generatedDefaults;
if (
  !validateSharedSettings(settings) ||
  !validateWorkspaceDocument(workspace) ||
  !validateSerialConfiguration(serialConfiguration)
)
  throw new ContractValidationError("Invalid Rust Host defaults");

export const defaults: Readonly<{
  settings: SharedSettings;
  workspace: WorkspaceDocument;
  serialConfiguration: SerialConfiguration;
}> = { settings, workspace, serialConfiguration };

export function parseReply(value: unknown): RpcReply {
  if (!validateRpcReply(value)) throw new ContractValidationError();
  return value;
}

export function parseWireFrame(value: unknown): WireFrame {
  if (!validateWireFrame(value))
    throw new ContractValidationError("Invalid Host state frame");
  return value;
}

export function parseSharedSettings(value: unknown): SharedSettings {
  if (!validateSharedSettings(value))
    throw new ContractValidationError("Invalid Host shared settings");
  return value;
}

export function parseObjectRef(value: unknown): ObjectRef {
  if (!validateObjectRef(value))
    throw new ContractValidationError("Invalid Host object reference");
  return value;
}

export function parseOperationsSnapshot(value: unknown): OperationsSnapshot {
  if (!validateOperationsSnapshot(value))
    throw new ContractValidationError("Invalid Host operations snapshot");
  return value;
}

export function parseCaptureRecord(value: unknown): CaptureRecord {
  if (!validateCaptureRecord(value))
    throw new ContractValidationError("Invalid Host capture record");
  return value;
}
