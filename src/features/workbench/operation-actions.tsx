import { useMemo, useState } from "react";
import type { Operation } from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import { useToolAction } from "./transfer-capture-actions";
import type {
  HostActionCheckInput,
  HostContextValue,
} from "@/providers/host-context";
import { useToolActionAvailability } from "./use-tool-action-availability";
import { nativeErrorCode } from "@/lib/native-error";
import { WorkbenchNotice } from "./workbench-notice";

export type OperationActionsLabels = Record<
  "operation" | "cancel" | "cancelRequested",
  string
>;
export type OperationActionsProps = {
  operation: Operation;
  watchActions: HostContextValue["watchActions"];
  labels: OperationActionsLabels;
  formatError?: (code: string | undefined) => string;
  disabled?: boolean;
  onCancel?: (operationId: string, signal?: AbortSignal) => Promise<unknown>;
};
export function OperationActions(props: OperationActionsProps) {
  return <OperationActionsView key={props.operation.operationId} {...props} />;
}
function OperationActionsView({
  operation,
  labels,
  disabled,
  onCancel,
  watchActions,
  formatError,
}: OperationActionsProps) {
  const action = useToolAction(
    (reason) => formatError?.(nativeErrorCode(reason)) ?? labels.operation,
  );
  const [requested, setRequested] = useState(false);
  const inputs = useMemo<HostActionCheckInput[]>(
    () => [
      {
        actionId: "operation.cancel",
        target: {
          hostId: operation.executionHostId,
          kind: "operation",
          id: operation.operationId,
        },
        params: { reason: "user" },
      },
    ],
    [operation.executionHostId, operation.operationId],
  );
  const allowed = useToolActionAvailability(inputs, watchActions);
  const cancellable =
    operation.state === "queued" || operation.state === "running";
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={
          disabled ||
          action.busy ||
          requested ||
          !cancellable ||
          !onCancel ||
          !allowed(inputs[0])
        }
        onClick={() =>
          void action.run(async (signal) => {
            if (
              disabled ||
              requested ||
              !cancellable ||
              !onCancel ||
              !allowed(inputs[0])
            )
              return;
            await onCancel!(operation.operationId, signal);
            if (!signal.aborted) setRequested(true);
          })
        }
      >
        {labels.cancel}
      </Button>
      {(operation.state === "cancel_requested" ||
        (requested && cancellable)) && (
        <p role="status">{labels.cancelRequested}</p>
      )}
      <WorkbenchNotice
        eventKey={action.eventKey}
        noticeKey={`${operation.operationId}:${action.failureIndex}`}
        log={{
          module: operation.actionId.startsWith("capture.")
            ? "capture"
            : "transfer",
          level: "error",
          message: action.error ?? "",
          code: action.errorCode,
        }}
      >
        {action.error ? <span role="alert">{action.error}</span> : null}
      </WorkbenchNotice>
    </div>
  );
}
