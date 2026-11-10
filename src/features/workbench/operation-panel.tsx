import type { Operation } from "@serial-workbench/contracts";
import type { WorkbenchLabels } from "./labels";
import { TransferReceipts, type ReceiptReader } from "./transfer-receipts";
import {
  isBusinessTask,
  operationName,
  operationProgress,
} from "./operation-text";
import { OperationDetails } from "./operation-details";
import { formatByteSize } from "./metric-format";
import { OperationActions } from "./operation-actions";
import type { HostContextValue } from "@/providers/host-context";
export function OperationPanel({
  operations,
  labels,
  readFileReceipts,
  watchActions,
  onCancelOperation,
  disabled,
}: {
  operations: readonly Operation[];
  labels: WorkbenchLabels;
  readFileReceipts?: ReceiptReader;
  watchActions?: HostContextValue["watchActions"];
  onCancelOperation?: (
    operation: Operation,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  disabled?: boolean;
}) {
  const tasks = operations.filter((operation) =>
    isBusinessTask(operation.actionId),
  );
  const text = labels.operationText;
  return (
    <section
      aria-label={labels.tasks}
      data-panel-id="tasks"
      className="workbench-operations"
    >
      <h2 className="sr-only">{labels.tasks}</h2>
      {!tasks.length && (
        <p className="text-muted-foreground">{labels.emptyTasks}</p>
      )}
      <ul>
        {tasks.map((operation) => (
          <li key={operation.operationId}>
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
            {operation.error && (
              <p role="alert">{text.failure(operation.error.code)}</p>
            )}
            {watchActions &&
              onCancelOperation &&
              (operation.state === "queued" ||
                operation.state === "running" ||
                operation.state === "cancel_requested") && (
                <OperationActions
                  operation={operation}
                  disabled={disabled}
                  watchActions={watchActions}
                  labels={{
                    operation: operationName(operation.actionId, text),
                    cancel: labels.cancel,
                    cancelRequested: labels.cancelRequested,
                  }}
                  formatError={text.failure}
                  onCancel={(_id, signal) =>
                    onCancelOperation(operation, signal)
                  }
                />
              )}
            {operation.result?.kind === "file_transfer" && (
              <>
                <dl className="workbench-transfer-result">
                  <div>
                    <dt>{labels.requestedBytes}</dt>
                    <dd aria-label={labels.requestedBytes}>
                      {formatByteSize(operation.result.value.requested)}
                    </dd>
                  </div>
                  <div>
                    <dt>{labels.acceptedBytes}</dt>
                    <dd aria-label={labels.acceptedBytes}>
                      {formatByteSize(operation.result.value.accepted)}
                    </dd>
                  </div>
                  <div>
                    <dt>{labels.unknownBytes}</dt>
                    <dd aria-label={labels.unknownBytes}>
                      {formatByteSize(operation.result.value.unknown)}
                    </dd>
                  </div>
                </dl>
                <p>
                  {operation.result.value.peerAcknowledged
                    ? labels.peerConfirmed
                    : labels.peerUnconfirmed}
                </p>
                {readFileReceipts && (
                  <TransferReceipts
                    key={`${operation.result.value.receiptsRef.hostId}:${operation.result.value.receiptsRef.id}:${operation.result.value.receiptsRef.revision ?? ""}`}
                    receiptsRef={operation.result.value.receiptsRef}
                    read={readFileReceipts}
                    labels={labels}
                  />
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
