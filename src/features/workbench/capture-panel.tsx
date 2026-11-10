import type { Operation, OperationSummary } from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import type { WorkbenchLabels } from "./labels";
import type { HostContextValue } from "@/providers/host-context";
import { OperationDetails } from "./operation-details";
import { operationName, operationProgress } from "./operation-text";
import {
  CaptureStatus,
  LiveCaptureStatus,
  type CaptureStatusReader,
  type CaptureStopper,
} from "./capture-status";

function CaptureOperationSummary({
  operation,
  labels,
}: {
  operation: OperationSummary;
  labels: WorkbenchLabels;
}) {
  const text = labels.operationText;
  const message = operation.errorCode
    ? text.failure(operation.errorCode)
    : undefined;
  return (
    <li>
      <div className="workbench-operation-heading">
        <span className="font-medium">
          {operationName(operation.actionId, text)}
        </span>
        <span>{text.states[operation.state]}</span>
        <OperationDetails operation={operation} label={text.details} />
      </div>
      {operation.progress && (
        <p>{operationProgress(operation.progress, text)}</p>
      )}
      {message && <p className="text-muted-foreground">{message}</p>}
    </li>
  );
}

export function CapturePanel({
  operations,
  summaries,
  labels,
  disabled,
  onStart,
  onStop,
  readStatus,
  startDisabled = disabled,
  onOpenReplay,
  replayDisabled = disabled,
  watchActions,
}: {
  operations: readonly Operation[];
  summaries: readonly OperationSummary[];
  labels: WorkbenchLabels;
  disabled: boolean;
  onStart?: () => void;
  onStop?: CaptureStopper;
  readStatus?: CaptureStatusReader;
  startDisabled?: boolean;
  onOpenReplay?: () => void;
  replayDisabled?: boolean;
  watchActions: HostContextValue["watchActions"];
}) {
  const captures = summaries.filter((operation) =>
    operation.actionId.startsWith("capture."),
  );
  return (
    <section
      aria-label={labels.capture}
      data-panel-id="capture"
      className="workbench-operations"
    >
      <h2 className="sr-only">{labels.capture}</h2>
      <div className="workbench-toolbar">
        <Button
          size="sm"
          variant="outline"
          onClick={onStart}
          disabled={startDisabled || !onStart}
        >
          {labels.startCapture}
        </Button>
        {onOpenReplay && (
          <Button
            size="sm"
            variant="outline"
            onClick={onOpenReplay}
            disabled={replayDisabled}
          >
            {labels.openReplay}
          </Button>
        )}
      </div>
      {!captures.length && (
        <p className="text-muted-foreground">{labels.emptyTasks}</p>
      )}
      <ul>
        {captures.map((operation) => (
          <CaptureOperationSummary
            key={operation.operationId}
            operation={operation}
            labels={labels}
          />
        ))}
      </ul>
      {operations
        .filter((operation) => operation.actionId === "capture.start")
        .map((operation) =>
          operation.result?.kind === "capture_status" ? (
            <CaptureStatus
              key={operation.operationId}
              value={operation.result.value}
              labels={labels}
              disabled={disabled}
              onStop={onStop}
              read={readStatus}
              watchActions={watchActions}
            />
          ) : operation.result?.kind === "reference" &&
            operation.result.value.resultRef.kind === "capture" &&
            readStatus ? (
            <LiveCaptureStatus
              key={operation.operationId}
              reference={operation.result.value.resultRef}
              read={readStatus}
              labels={labels}
              disabled={disabled}
              onStop={onStop}
              watchActions={watchActions}
            />
          ) : null,
        )}
    </section>
  );
}
