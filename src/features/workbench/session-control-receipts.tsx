import type {
  Operation,
  SerialConfiguration,
} from "@serial-workbench/contracts";
import { Textarea } from "@/components/ui/textarea";
import { CONFIG_FIELDS } from "./serial-configuration";
import { OperationDetails } from "./operation-details";
import { operationName } from "./operation-text";
import type { SessionControlsLabels } from "./session-controls";

function configurationValue(
  field: keyof SerialConfiguration,
  value: unknown,
  labels: SessionControlsLabels,
): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return labels.unknown;
  switch (field) {
    case "parity":
      return value === "none" ||
        value === "even" ||
        value === "odd" ||
        value === "mark" ||
        value === "space"
        ? labels[value]
        : labels.unknown;
    case "stopBits":
      return value === "one" || value === "onePointFive" || value === "two"
        ? labels[value]
        : labels.unknown;
    case "flowControl":
      return value === "none" ||
        value === "rtsCts" ||
        value === "xonXoff" ||
        value === "dsrDtr"
        ? labels[value]
        : labels.unknown;
    default:
      return /^\d+$/.test(value) ? value : labels.unknown;
  }
}

function controlStatus(
  status: "confirmed" | "failed" | "unknown",
  labels: SessionControlsLabels,
) {
  return status === "confirmed"
    ? labels.confirmed
    : status === "failed"
      ? labels.operationText.states.failed
      : labels.unknown;
}

export function SessionControlReceipts({
  operations,
  labels,
}: {
  operations: readonly Operation[];
  labels: SessionControlsLabels;
}) {
  return (
    <section
      aria-label={labels.receipt}
      className="space-y-3"
      aria-live="polite"
    >
      {operations.map((operation) => (
        <article
          key={operation.operationId}
          className="space-y-2 border-t pt-2"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">
              {operationName(operation.actionId, labels.operationText)}
            </span>
            <span>{labels.operationText.states[operation.state]}</span>
            <OperationDetails operation={operation} label={labels.details}>
              <p className="text-xs">{labels.waitOutcome}</p>
              {operation.result && (
                <Textarea
                  aria-label={
                    operation.result.kind === "configuration"
                      ? labels.readback
                      : operation.result.kind === "break"
                        ? labels.breakReceipt
                        : operation.result.kind === "control"
                          ? labels.controlReceipt
                          : labels.receipt
                  }
                  value={JSON.stringify(operation.result.value, null, 2)}
                  readOnly
                  className="workbench-log-details"
                />
              )}
            </OperationDetails>
          </div>
          {operation.error && <p>{labels.failure(operation.error.code)}</p>}
          {operation.result?.kind === "configuration" && (
            <table
              aria-label={labels.configurationReceipt}
              className="w-full text-xs"
            >
              <thead>
                <tr>
                  <th>{labels.field}</th>
                  <th>{labels.requested}</th>
                  <th>{labels.status}</th>
                  <th>{labels.actual}</th>
                </tr>
              </thead>
              <tbody>
                {CONFIG_FIELDS.map((field) => {
                  const receipt = operation.result;
                  if (receipt?.kind !== "configuration") return null;
                  const actual = receipt.value.fields.find(
                    (value) => value.field === field,
                  );
                  return (
                    <tr key={field}>
                      <th scope="row" className="py-1 text-start">
                        {labels[field]}
                      </th>
                      <td>
                        {configurationValue(
                          field,
                          receipt.value.requested[field],
                          labels,
                        )}
                      </td>
                      <td>
                        {actual?.status === "applied"
                          ? labels.applied
                          : actual?.status === "rejected"
                            ? labels.rejected
                            : labels.unknown}
                      </td>
                      <td>
                        {configurationValue(field, actual?.actual, labels)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {operation.result?.kind === "break" && (
            <dl
              aria-label={labels.breakReceipt}
              className="grid grid-cols-2 gap-2 text-xs"
            >
              <div>
                <dt>{labels.on}</dt>
                <dd>
                  {controlStatus(operation.result.value.assert.status, labels)}
                </dd>
              </div>
              <div>
                <dt>{labels.off}</dt>
                <dd>
                  {controlStatus(operation.result.value.clear.status, labels)}
                </dd>
              </div>
            </dl>
          )}
          {operation.result?.kind === "control" && (
            <p aria-label={labels.controlReceipt} className="text-xs">
              {operation.result.value.line.toUpperCase()} · {labels.requested}:{" "}
              {operation.result.value.requested ? labels.on : labels.off} ·{" "}
              {labels.actual}:{" "}
              {operation.result.value.actual === undefined
                ? labels.unknown
                : operation.result.value.actual
                  ? labels.on
                  : labels.off}{" "}
              · {controlStatus(operation.result.value.status, labels)}
            </p>
          )}
          {operation.result?.kind === "drained" && (
            <p className="text-xs">
              {controlStatus(operation.result.value.status, labels)}
            </p>
          )}
          {operation.result?.kind === "purged" && (
            <p className="text-xs">
              {labels[operation.result.value.direction]} ·{" "}
              {labels[operation.result.value.scope]} ·{" "}
              {operation.result.value.outcome === "completed"
                ? labels.confirmed
                : operation.result.value.outcome === "partial"
                  ? labels.partial
                  : labels.unknown}
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
