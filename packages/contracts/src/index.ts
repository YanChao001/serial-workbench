import type {
  ActivitySnapshot,
  CaptureRecord,
  CaptureStorageLimits,
  ObjectRef,
  OperationsSnapshot,
  RpcReply,
  SerialConfiguration,
  SharedSettings,
  TerminalTypography,
  WireFrame,
  WorkspaceDocument,
} from "./generated/types.ts";
import {
  validateActivitySnapshot,
  validateCaptureRecord,
  validateCaptureStorageLimits,
  validateObjectRef,
  validateOperationsSnapshot,
  validateRpcReply,
  validateSerialConfiguration,
  validateSharedSettings,
  validateTerminalTypography,
  validateWireFrame,
  validateWorkspaceDocument,
} from "./generated/validators.mjs";
import generatedDefaults from "./generated/defaults.json";
import { ContractValidationError } from "./contract-validation-error.ts";

export { ContractValidationError } from "./contract-validation-error.ts";
export type * from "./generated/types.ts";
export {
  validateCursor,
  validateNodePackageId,
  validateNodePackageIntegrity,
  validateNodePackageInstallation,
  validateNodePackageManifest,
  validateNodePackagePath,
  validateNodePackageRegistration,
  validateNodePackageSignature,
  validateNodePackageVersion,
  validateNodeSourceApproveParams,
} from "./generated/validators.mjs";
export {
  HOST_PROTOCOL_VERSION,
  NODE_PACKAGE_SIGNATURE_PREFIX,
  TX_MAX_BYTES,
} from "./generated/types.ts";

const {
  settings,
  workspace,
  serialConfiguration,
  terminalTypography,
  captureStorageLimits,
} = generatedDefaults;
if (
  !validateSharedSettings(settings) ||
  !validateWorkspaceDocument(workspace) ||
  !validateSerialConfiguration(serialConfiguration) ||
  !validateTerminalTypography(terminalTypography) ||
  !validateCaptureStorageLimits(captureStorageLimits)
)
  throw new ContractValidationError("Invalid Rust Host defaults");

export const defaults: Readonly<{
  settings: SharedSettings;
  workspace: WorkspaceDocument;
  serialConfiguration: SerialConfiguration;
  terminalTypography: TerminalTypography;
  captureStorageLimits: CaptureStorageLimits;
}> = {
  settings,
  workspace,
  serialConfiguration,
  terminalTypography,
  captureStorageLimits,
};

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
export function parseSerialConfiguration(value: unknown): SerialConfiguration {
  if (!validateSerialConfiguration(value))
    throw new ContractValidationError("Invalid serial configuration");
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

export function parseActivitySnapshot(value: unknown): ActivitySnapshot {
  if (!validateActivitySnapshot(value))
    throw new ContractValidationError("Invalid Host activity snapshot");
  return value;
}

export function parseCaptureRecord(value: unknown): CaptureRecord {
  if (!validateCaptureRecord(value))
    throw new ContractValidationError("Invalid Host capture record");
  return value;
}
