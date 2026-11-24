import type {
  SessionSnapshot,
  StreamItem,
  DeviceDescriptor,
  TextEncoding,
} from "@serial-workbench/contracts";
import { useId, useMemo, useState } from "react";
import { OptionsSelect } from "@/components/options-select";
import { detectTextEncoding } from "@/lib/encoding-detection";
import { ENCODING_NAMES } from "@/lib/text-encoding";
import { receiveEncodingSample } from "./encoding-sample";
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

type DiagnosticMode = "overview" | "open" | "encoding" | "loss" | "disconnect";

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
  | "linuxMissing"
  | "check"
  | "overview"
  | "connectionProblem"
  | "encodingProblem"
  | "lossProblem"
  | "disconnectProblem"
  | "noOpenFailure"
  | "currentEncoding"
  | "detectedEncoding"
  | "sampleBytes"
  | "insufficient"
  | "automatic"
  | "bom"
  | "utf8"
  | "distribution"
  | "applyEncoding"
  | "readerGapRecords"
  | "sourceGapRecords"
  | "noGap"
  | "gapHelp"
  | "waitingReconnect"
  | "attemptingReconnect"
  | "rebindRequired"
  | "stoppedReconnect"
  | "idleReconnect"
  | "reconnectStatus"
  | "attemptCount"
  | "noDisconnect"
  | "noSession"
  | "sessionOpening"
  | "sessionClosing"
  | "sessionClosed",
  string
> &
  Partial<
    Record<
      | "capacity"
      | "port"
      | "driver"
      | "connectionState"
      | "errorCode"
      | "connected"
      | "disconnected",
      string
    >
  >;
export type DiagnosticPanelProps = {
  labels: DiagnosticLabels;
  items: readonly StreamItem[];
  session?: SessionSnapshot;
  openError?: WorkbenchFailure;
  streamError?: Error | null;
  platform?: Platform;
  device?: DeviceDescriptor;
  openTarget?: {
    device?: DeviceDescriptor;
    session?: SessionSnapshot;
    retry?: () => void;
  };
  receiveEncoding?: TextEncoding | null;
  sourceHostId?: string;
  onApplyEncoding?: (value: TextEncoding) => void;
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
    case "LIMIT_EXCEEDED":
      return "capacity";
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
  device,
  openTarget,
  receiveEncoding,
  sourceHostId,
  onApplyEncoding,
  onInspectBytes,
  onInspectMetrics,
  onReconnect,
}: DiagnosticPanelProps) {
  const id = useId();
  const [mode, setMode] = useState<DiagnosticMode>("overview");
  const sessionId = session?.sessionId;
  const sessionEpoch = session?.sessionEpoch;
  const configurationRevision = session?.configurationRevision;
  const scopedItems = useMemo(() => {
    if (!sessionId || !sessionEpoch) return [];
    return items.filter((item) => {
      const identity = item.kind === "reader_gap" ? item.gap : item.event;
      return (
        identity.sessionId === sessionId &&
        identity.sessionEpoch === sessionEpoch &&
        (sourceHostId === undefined || identity.hostId === sourceHostId)
      );
    });
  }, [items, sessionId, sessionEpoch, sourceHostId]);
  const gaps = scopedItems.filter(
    (item) => item.kind === "reader_gap" || item.event.kind === "gap",
  );
  const readerGaps = gaps.filter((item) => item.kind === "reader_gap").length;
  const detection = useMemo(() => {
    if (mode !== "encoding") return;
    const current = scopedItems.filter(
      (item) =>
        item.kind === "reader_gap" ||
        item.event.kind !== "rx" ||
        item.event.configurationRevision === configurationRevision,
    );
    return detectTextEncoding(receiveEncodingSample(current));
  }, [mode, scopedItems, configurationRevision]);
  const reconnect = session?.reconnect;
  const reconnectState =
    reconnect &&
    {
      idle: labels.idleReconnect,
      waiting: labels.waitingReconnect,
      attempting: labels.attemptingReconnect,
      requires_rebind: labels.rebindRequired,
      stopped: labels.stoppedReconnect,
    }[reconnect.state];
  const overview = mode === "overview";
  const focusedSession =
    mode === "open" && openTarget ? openTarget.session : session;
  const focusedDevice =
    mode === "open" && openTarget ? openTarget.device : device;
  const connectionState = focusedSession
    ? {
        open: labels.connected,
        opening: labels.sessionOpening,
        disconnected: labels.disconnected,
        closing: labels.sessionClosing,
        closed: labels.sessionClosed,
      }[focusedSession.state]
    : labels.disconnected;
  const disconnected = session?.state === "disconnected";
  const streamCode = nativeErrorCode(streamError);
  const streamPermissionDenied = streamCode === "PERMISSION_DENIED";
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
  const reconnectCode = reconnect?.lastError?.code;
  const connectionCode = openError?.code;
  const codes = {
    overview: [connectionCode, streamCode],
    open: [connectionCode],
    encoding: [],
    loss: [streamCode],
    disconnect: [reconnectCode],
  }[mode].filter((code): code is string => Boolean(code));
  const technical = [
    ...codes,
    ...(mode === "loss" || overview
      ? gaps.map((item) => JSON.stringify(item))
      : []),
  ].join("\n");
  const retryingOpen = mode === "open" || (overview && !!openError);
  const retry = retryingOpen && openTarget ? openTarget.retry : onReconnect;
  const showRetry = retryingOpen
    ? !!openError || focusedSession?.state !== "open"
    : (mode === "disconnect" && disconnected) ||
      (mode === "loss" && canRestoreStreamAccess) ||
      (overview && (disconnected || canRestoreStreamAccess));
  const restoreAccess = retryingOpen
    ? connectionCode === "PERMISSION_DENIED"
    : canRestoreStreamAccess;
  return (
    <section aria-label={labels.diagnostics} className="workbench-diagnostics">
      <div className="grid gap-1.5">
        <label htmlFor={id}>{labels.check}</label>
        <OptionsSelect<DiagnosticMode>
          id={id}
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "overview", label: labels.overview },
            { value: "open", label: labels.connectionProblem },
            { value: "encoding", label: labels.encodingProblem },
            { value: "loss", label: labels.lossProblem },
            { value: "disconnect", label: labels.disconnectProblem },
          ]}
        />
      </div>
      <dl className="workbench-diagnostic-facts">
        {focusedDevice && (
          <>
            <div>
              <dt>{labels.port ?? labels.diagnostics}</dt>
              <dd>
                {focusedDevice.systemName}
                {focusedDevice.description
                  ? ` · ${focusedDevice.description}`
                  : ""}
              </dd>
            </div>
            {focusedDevice.driver && (
              <div>
                <dt>{labels.driver ?? labels.details}</dt>
                <dd>{focusedDevice.driver}</dd>
              </div>
            )}
          </>
        )}
        {labels.connectionState && (
          <div>
            <dt>{labels.connectionState}</dt>
            <dd>{connectionState}</dd>
          </div>
        )}
        {labels.errorCode && codes[0] && (
          <div>
            <dt>{labels.errorCode}</dt>
            <dd>
              <code>{codes[0]}</code>
            </dd>
          </div>
        )}
      </dl>
      {overview &&
        !openError &&
        !streamError &&
        !gaps.length &&
        !disconnected && <p>{labels.noIssues}</p>}
      {(overview || mode === "open") && openError && (
        <div>
          <h3>
            {labels.cannotOpen}
            {openError.context ? ` · ${openError.context}` : ""}
          </h3>
          <p>{labels[cause] ?? labels.unknownFailure}</p>
          {platformSteps.length > 0 && (
            <ol>
              {platformSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
        </div>
      )}
      {mode === "open" && !openError && <p>{labels.noOpenFailure}</p>}
      {detection && (
        <div className="grid gap-2">
          <h3>{labels.encodingProblem}</h3>
          <dl className="workbench-diagnostic-facts">
            {receiveEncoding !== undefined && (
              <div>
                <dt>{labels.currentEncoding}</dt>
                <dd>
                  {receiveEncoding === null
                    ? labels.automatic
                    : ENCODING_NAMES[receiveEncoding]}
                </dd>
              </div>
            )}
            <div>
              <dt>{labels.sampleBytes}</dt>
              <dd>{detection.sampleBytes}</dd>
            </div>
            <div>
              <dt>{labels.detectedEncoding}</dt>
              <dd>
                {detection.reason === "pending" ? (
                  labels.insufficient
                ) : (
                  <>
                    <span>{ENCODING_NAMES[detection.encoding]}</span>
                    {" · "}
                    <span>
                      {
                        {
                          bom: labels.bom,
                          utf8: labels.utf8,
                          guess:
                            labels.distribution +
                            " " +
                            detection.confidence +
                            "/100",
                        }[detection.reason]
                      }
                    </span>
                  </>
                )}
              </dd>
            </div>
          </dl>
          <div className="workbench-toolbar">
            {onInspectBytes && (
              <Button size="sm" variant="outline" onClick={onInspectBytes}>
                {labels.hex}
              </Button>
            )}
            {detection.reason !== "pending" && onApplyEncoding && (
              <Button
                size="sm"
                onClick={() => onApplyEncoding(detection.encoding)}
              >
                {labels.applyEncoding}
              </Button>
            )}
          </div>
        </div>
      )}
      {(mode === "loss" || (overview && (streamError || gaps.length > 0))) && (
        <div>
          <h3>{labels.inspectGaps}</h3>
          <p>
            {streamPermissionDenied
              ? labels.permissionDenied
              : streamError
                ? labels.streamFailed
                : gaps.length > 0
                  ? labels.gapDetected
                  : session
                    ? labels.noGap
                    : labels.noSession}
          </p>
          {mode === "loss" && session && (
            <>
              <dl className="workbench-diagnostic-facts">
                <div>
                  <dt>{labels.readerGapRecords}</dt>
                  <dd>{readerGaps}</dd>
                </div>
                <div>
                  <dt>{labels.sourceGapRecords}</dt>
                  <dd>{gaps.length - readerGaps}</dd>
                </div>
              </dl>
              {gaps.length > 0 && <p>{labels.gapHelp}</p>}
            </>
          )}
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
      {(mode === "disconnect" || (overview && disconnected)) && (
        <div>
          <h3>{labels.inspectDisconnect}</h3>
          <p>
            {disconnected
              ? labels.disconnectHelp
              : session
                ? labels.noDisconnect
                : labels.noSession}
          </p>
          {reconnect && (
            <dl className="workbench-diagnostic-facts">
              <div>
                <dt>{labels.reconnectStatus}</dt>
                <dd>{reconnectState}</dd>
              </div>
              <div>
                <dt>{labels.attemptCount}</dt>
                <dd>{reconnect.attempts}</dd>
              </div>
            </dl>
          )}
        </div>
      )}
      <div className="workbench-toolbar">
        {retry && showRetry && (
          <Button size="sm" onClick={retry}>
            {restoreAccess ? labels.restoreAccess : labels.open}
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
