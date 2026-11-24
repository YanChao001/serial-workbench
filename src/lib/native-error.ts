import type { Translate } from "@/i18n/translate";
import type { MessageKey } from "@/i18n/zh-CN";
import { isRecord } from "./settings-model";
const ERROR_KEYS: Record<string, MessageKey> = {
  ACCESS_DENIED: "nativeError.accessDenied",
  DEVICE_BUSY: "nativeError.deviceBusy",
  PLUGIN_TRANSPORT_OPEN_FAILED: "nativeError.pluginTransportOpenFailed",
  HOST_BUSY: "nativeError.hostBusy",
  BROWSER_CONNECTION_CLOSED: "workbench.hostUnavailable",
  BROWSER_ASSETS_UNAVAILABLE: "browserAccess.assetsUnavailable",
  LAN_BIND_FAILED: "lanAccess.bindFailed",
  LAN_PEER_CONFLICT: "lanAccess.peerConflict",
  LAN_PEER_NOT_PAIRED: "lanConnection.notPaired",
  LAN_UNAVAILABLE: "lanConnection.unavailable",
  LAN_HOST_ID_MISMATCH: "lanConnection.wrongHost",
  TAKEOVER_DECLINED: "browserTakeover.declined",
  TAKEOVER_EXPIRED: "browserTakeover.expired",
  TAKEOVER_PENDING: "browserTakeover.pending",
  LIMIT_EXCEEDED: "nativeError.limitExceeded",
  WORKSPACE_DELETED: "nativeError.workspaceDeleted",
  WRITE_TIMEOUT: "nativeError.writeTimeout",
  CONTROL_UNKNOWN: "nativeError.controlUnknown",
  DEV_RUNTIME_MISMATCH: "nativeError.devRuntimeMismatch",
  READER_OVERFLOW: "nativeError.readerOverflow",
  REPLAY_CLOCK_UNAVAILABLE: "nativeError.replayClockUnavailable",
  CONFIGURATION_CONFLICT: "nativeError.configurationConflict",
  UNSUPPORTED_CAPABILITY: "errors.UNSUPPORTED",
  REVISION_CONFLICT: "errors.CONFLICT",
  PERMISSION_DENIED: "nativeError.permissionDenied",
  UNAUTHENTICATED: "nativeError.unauthenticated",
  CLIPBOARD_WRITE_FAILED: "nativeError.clipboardWriteFailed",
  INVALID_ARGUMENT: "errors.VALIDATION",
  USER_CANCELLED: "nativeError.userCancelled",
  WORKBENCH_BUSY: "nativeError.busy",
  INPUT_TOO_LONG: "errors.INPUT_TOO_LONG",
  STORAGE_FULL: "commandLibrary.storageFull",
  GROUP_NOT_EMPTY: "commandLibrary.groupNotEmpty",
  INVALID_COMMAND_ARCHIVE: "commandLibrary.invalidArchive",
  TARGET_EXISTS: "nativeError.targetExists",
  STORAGE_IO: "errors.IO",
  STORAGE_CORRUPT: "errors.IO",
  PLATFORM_UNAVAILABLE: "errors.UNSUPPORTED",
  NATIVE_BUSY: "nativeError.busy",
  AUTOSTART_ERROR: "errors.AUTOSTART_ERROR",
  UPDATE_BUSY: "errors.UPDATE_BUSY",
  UPDATE_CHECK_FAILED: "errors.UPDATE",
  UPDATE_CHECK_TIMEOUT: "updates.checkTimeout",
  UPDATE_FEED_UNAVAILABLE: "updates.feedUnavailable",
  UPDATE_PLATFORM_UNAVAILABLE: "updates.platformUnavailable",
  UPDATE_DOWNLOAD_FAILED: "errors.UPDATE",
  UPDATE_INSTALL_FAILED: "errors.UPDATE",
  UPDATE_HOST_RECOVERY_REQUIRED: "updates.hostRecoveryRequired",
  WINDOW_ERROR: "errors.WINDOW_ERROR",
  VALIDATION: "errors.VALIDATION",
  CONFLICT: "errors.CONFLICT",
  SETTINGS_CONFLICT: "errors.SETTINGS_CONFLICT",
  NOT_FOUND: "errors.NOT_FOUND",
  IO: "errors.IO",
  UPDATE_NOT_CONFIGURED: "errors.UPDATE_NOT_CONFIGURED",
  UPDATE: "errors.UPDATE",
  UNSUPPORTED: "errors.UNSUPPORTED",
  INTERNAL: "errors.INTERNAL",
};
export function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string")
    return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
export function nativeErrorCode(error: unknown): string | undefined {
  return isRecord(error) &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : undefined;
}
export function nativeErrorText(error: unknown, t: Translate): string {
  const key =
    isRecord(error) &&
    typeof error.code === "string" &&
    Object.hasOwn(ERROR_KEYS, error.code)
      ? ERROR_KEYS[error.code]
      : undefined;
  if (key) return t(key);
  if (
    typeof error === "string" ||
    (isRecord(error) && typeof error.message === "string")
  )
    return t("common.operationFailed", { error: errorMessage(error) });
  return t("errors.INTERNAL");
}
