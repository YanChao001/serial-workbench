import type { SessionSnapshot, StreamItem } from "@serial-workbench/contracts";
import type { WorkbenchLabels } from "./labels";
import { Button } from "@/components/ui/button";
export type DiagnosticLabels = Pick<
  WorkbenchLabels,
  | "connectionHelp"
  | "encodingHelp"
  | "gapHelp"
  | "disconnectHelp"
  | "refresh"
  | "hex"
  | "metrics"
  | "open"
> & {
  diagnostics: string;
  cannotOpen: string;
  inspectEncoding: string;
  inspectGaps: string;
  inspectDisconnect: string;
  noRecordedGap: string;
  platformHelp: string;
  platformRefresh: string;
  windows: string;
  windowsDeviceManager: string;
  windowsRelease: string;
  windowsDriver: string;
  macos: string;
  macosHardware: string;
  macosAccessory: string;
  macosRelease: string;
  macosDriver: string;
  linux: string;
  linuxPermissions: string;
  linuxGroup: string;
  linuxMissing: string;
};
export type DiagnosticPanelProps = {
  labels: DiagnosticLabels;
  items: readonly StreamItem[];
  session?: SessionSnapshot;
  openError?: string;
  streamError?: Error | null;
  onRefresh: () => void;
  onInspectBytes?: () => void;
  onInspectMetrics?: () => void;
  onReconnect?: () => void;
};
export function DiagnosticPanel({
  labels,
  items,
  session,
  openError,
  streamError,
  onRefresh,
  onInspectBytes,
  onInspectMetrics,
  onReconnect,
}: DiagnosticPanelProps) {
  const gaps = items.flatMap((item) =>
    item.kind === "reader_gap"
      ? [
          `${item.gap.reason} [${item.gap.missingEventRange.start}, ${item.gap.missingEventRange.end})`,
        ]
      : item.event.kind === "gap"
        ? [
            `${item.event.payload.reason}${item.event.payload.missingByteRange ? ` [${item.event.payload.missingByteRange.start}, ${item.event.payload.missingByteRange.end})` : ""}`,
          ]
        : [],
  );
  return (
    <section aria-label={labels.diagnostics}>
      <h2>{labels.diagnostics}</h2>
      <div>
        <h3>{labels.cannotOpen}</h3>
        {openError && (
          <p>
            <code>{openError}</code>
          </p>
        )}
        <p>{labels.connectionHelp}</p>
        <p>{labels.platformHelp}</p>
        {[
          {
            title: labels.windows,
            steps: [
              labels.windowsDeviceManager,
              labels.windowsRelease,
              labels.windowsDriver,
            ],
          },
          {
            title: labels.macos,
            steps: [
              labels.macosHardware,
              labels.macosAccessory,
              labels.macosRelease,
              labels.macosDriver,
            ],
          },
          {
            title: labels.linux,
            steps: [
              labels.linuxPermissions,
              labels.linuxGroup,
              labels.linuxMissing,
            ],
          },
        ].map(({ title, steps }) => (
          <details key={title}>
            <summary>{title}</summary>
            <ol className="list-decimal space-y-2 pl-6">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </details>
        ))}
        <p>{labels.platformRefresh}</p>
        <Button size="sm" variant="ghost" onClick={onRefresh}>
          {labels.refresh}
        </Button>
      </div>
      <div>
        <h3>{labels.inspectEncoding}</h3>
        <p>{labels.encodingHelp}</p>
        <Button
          size="sm"
          variant="ghost"
          disabled={!onInspectBytes}
          onClick={onInspectBytes}
        >
          {labels.hex}
        </Button>
      </div>
      <div>
        <h3>{labels.inspectGaps}</h3>
        {streamError && (
          <p>
            <code>{streamError.message}</code>
          </p>
        )}
        {gaps.length ? (
          <ul>
            {gaps.map((gap, index) => (
              <li key={index}>{gap}</li>
            ))}
          </ul>
        ) : (
          <p>{labels.noRecordedGap}</p>
        )}
        <p>{labels.gapHelp}</p>
        <Button
          size="sm"
          variant="ghost"
          disabled={!onInspectMetrics}
          onClick={onInspectMetrics}
        >
          {labels.metrics}
        </Button>
      </div>
      <div>
        <h3>{labels.inspectDisconnect}</h3>
        {session?.state === "disconnected" && (
          <p>
            {session.state}
            {session.reconnect
              ? ` · ${session.reconnect.state} · ${session.reconnect.attempts}`
              : ""}
          </p>
        )}
        <p>{labels.disconnectHelp}</p>
        <Button
          size="sm"
          variant="ghost"
          disabled={session?.state !== "disconnected" || !onReconnect}
          onClick={onReconnect}
        >
          {labels.open}
        </Button>
      </div>
    </section>
  );
}
