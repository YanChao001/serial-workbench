import type { Operation } from "@serial-workbench/contracts";
import type { WorkbenchLabels } from "./labels";
import { TransferReceipts, type ReceiptReader } from "./transfer-receipts";
export function OperationPanel({
  operations,
  labels,
  readFileReceipts,
}: {
  operations: readonly Operation[];
  labels: WorkbenchLabels;
  readFileReceipts?: ReceiptReader;
}) {
  return (
    <section
      aria-label={labels.tasks}
      data-panel-id="tasks"
      className="workbench-operations"
    >
      <h2 className="sr-only">{labels.tasks}</h2>
      {!operations.length && (
        <p className="text-muted-foreground">{labels.emptyTasks}</p>
      )}
      <ul>
        {operations.map((operation) => (
          <li key={operation.operationId}>
            <span className="font-medium">{operation.actionId}</span>{" "}
            <span>{operation.state}</span>
            {operation.progress && (
              <p>
                {operation.progress.completed}
                {operation.progress.total
                  ? ` / ${operation.progress.total}`
                  : ""}{" "}
                {operation.progress.unit}
              </p>
            )}
            {operation.error && (
              <p role="alert">
                {operation.error.code}: {operation.error.message}
              </p>
            )}
            {operation.result?.kind === "tx" && (
              <p>
                {operation.result.value.outcome} [
                {operation.result.value.byteStart},{" "}
                {operation.result.value.byteEnd})
              </p>
            )}
            {operation.result?.kind === "file_transfer" && (
              <>
                <dl className="workbench-transfer-result">
                  <div>
                    <dt>{labels.requestedBytes}</dt>
                    <dd aria-label={labels.requestedBytes}>
                      {operation.result.value.requested}
                    </dd>
                  </div>
                  <div>
                    <dt>{labels.acceptedBytes}</dt>
                    <dd aria-label={labels.acceptedBytes}>
                      {operation.result.value.accepted}
                    </dd>
                  </div>
                  <div>
                    <dt>{labels.unknownBytes}</dt>
                    <dd aria-label={labels.unknownBytes}>
                      {operation.result.value.unknown}
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
