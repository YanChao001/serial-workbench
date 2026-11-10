import type { SessionSnapshot, StreamItem } from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { getPlatform, type Platform } from "@/lib/platform";
import { nativeErrorCode } from "@/lib/native-error";
import type { WorkbenchFailure } from "./workbench-failure";

export type DiagnosticLabels = Record<
  | "diagnostics"
  | "cannotOpen"
  | "inspectGaps"
  | "inspectDisconnect"
  | "metrics"
  | "hex"
  | "open"
  | "restoreAccess"
  | "details"
  | "noIssues"
  | "accessDenied"
  | "permissionDenied"
  | "missingDevice"
  | "configurationConflict"
  | "staleSession"
  | "unknownFailure"
  | "streamFailed"
  | "gapDetected"
  | "disconnectHelp"
  | "windowsDeviceManager"
  | "windowsRelease"
  | "windowsDriver"
  | "macosHardware"
  | "macosAccessory"
  | "macosRelease"
  | "macosDriver"
  | "linuxPermissions"
  | "linuxGroup"
  | "linuxMissing",
  string
>;
export type DiagnosticPanelProps = {
  labels: DiagnosticLabels;
  items: readonly StreamItem[];
  session?: SessionSnapshot;
  openError?: WorkbenchFailure;
  streamError?: Error | null;
  platform?: Platform;
  onInspectBytes?: () => void;
  onInspectMetrics?: () => void;
  onReconnect?: () => void;
};

function connectionCause(code: string | undefined): keyof DiagnosticLabels {
  switch (code) {
    case "ACCESS_DENIED":
    case "DEVICE_BUSY":
    case "PORT_BUSY":
    case "RESOURCE_BUSY":
      return "accessDenied";
    case "PERMISSION_DENIED":
      return "permissionDenied";
    case "DEVICE_NOT_FOUND":
    case "NOT_FOUND":
      return "missingDevice";
    case "CONFIGURATION_CONFLICT":
      return "configurationConflict";
    case "EPOCH_MISMATCH":
    case "HOST_RESTARTED":
    case "STALE_ATTACHMENT":
      return "staleSession";
    default:
      return "unknownFailure";
  }
}

export function DiagnosticPanel({
  labels,
  items,
  session,
  openError,
  streamError,
  platform = getPlatform(),
  onInspectBytes,
  onInspectMetrics,
  onReconnect,
}: DiagnosticPanelProps) {
  const gaps = items.filter(
    (item) => item.kind === "reader_gap" || item.event.kind === "gap",
  );
  const disconnected = session?.state === "disconnected";
  const streamPermissionDenied =
    nativeErrorCode(streamError) === "PERMISSION_DENIED";
  const canRestoreStreamAccess =
    streamPermissionDenied && session?.state === "open" && !session.readOnly;
  const cause = connectionCause(openError?.code);
  // 平台只决定帮助文案；不据此推断权限、端口占用者或驱动状态。
  const platformSteps =
    openError &&
    ["accessDenied", "missingDevice", "unknownFailure"].includes(cause)
      ? platform === "windows"
        ? cause === "accessDenied"
          ? [labels.windowsRelease, labels.windowsDeviceManager]
          : [labels.windowsDeviceManager, labels.windowsDriver]
        : platform === "macos"
          ? cause === "accessDenied"
            ? [labels.macosRelease, labels.macosAccessory]
            : [labels.macosHardware, labels.macosDriver]
          : platform === "linux"
            ? cause === "accessDenied"
              ? [labels.linuxPermissions, labels.linuxGroup]
              : [labels.linuxMissing]
            : []
      : [];
  const technical = [
    openError?.code,
    nativeErrorCode(streamError),
    ...gaps.map((item) => JSON.stringify(item)),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <section aria-label={labels.diagnostics} className="workbench-diagnostics">
      {!openError && !streamError && !gaps.length && !disconnected && (
        <p>{labels.noIssues}</p>
      )}
      {openError && (
        <div>
          <h3>
            {labels.cannotOpen}
            {openError.context ? ` · ${openError.context}` : ""}
          </h3>
          <p>{labels[cause]}</p>
          {platformSteps.length > 0 && (
            <ol>
              {platformSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
        </div>
      )}
      {(streamError || gaps.length > 0) && (
        <div>
          <h3>{labels.inspectGaps}</h3>
          <p>
            {streamPermissionDenied
              ? labels.permissionDenied
              : streamError
                ? labels.streamFailed
                : labels.gapDetected}
          </p>
          <div className="workbench-toolbar">
            {onInspectBytes && (
              <Button size="sm" variant="outline" onClick={onInspectBytes}>
                {labels.hex}
              </Button>
            )}
            {onInspectMetrics && (
              <Button size="sm" variant="outline" onClick={onInspectMetrics}>
                {labels.metrics}
              </Button>
            )}
          </div>
        </div>
      )}
      {disconnected && (
        <div>
          <h3>{labels.inspectDisconnect}</h3>
          <p>{labels.disconnectHelp}</p>
        </div>
      )}
      <div className="workbench-toolbar">
        {(openError || disconnected || canRestoreStreamAccess) &&
          onReconnect && (
            <Button size="sm" onClick={onReconnect}>
              {canRestoreStreamAccess || openError?.code === "PERMISSION_DENIED"
                ? labels.restoreAccess
                : labels.open}
            </Button>
          )}
        {technical && (
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline">
                {labels.details}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="workbench-detail-popover" align="start">
              <Textarea
                aria-label={labels.details}
                value={technical}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
                className="workbench-log-details"
              />
            </PopoverContent>
          </Popover>
        )}
      </div>
    </section>
  );
}
