import type { OperationSummary } from "@serial-workbench/contracts";
import { Button } from "@/components/ui/button";
import type { WorkbenchLabels } from "./labels";
import {
  OperationInputView,
  type OperationInputReader,
} from "./operation-input";
export function ActivityPanel({
  operations,
  labels,
  following,
  onFollowChange,
  onLocate,
  readInput,
  canLocate,
}: {
  operations: readonly OperationSummary[];
  labels: WorkbenchLabels;
  following: boolean;
  onFollowChange: (value: boolean) => void;
  onLocate: (operation: OperationSummary) => void;
  readInput?: OperationInputReader;
  canLocate?: (operation: OperationSummary) => boolean;
}) {
  return (
    <section
      aria-label={labels.activity}
      data-panel-id="activity"
      className="workbench-activity"
    >
      <div className="workbench-toolbar">
        <h2 className="sr-only">{labels.activity}</h2>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={following}
          onClick={() => onFollowChange(!following)}
        >
          {following ? labels.pauseFollow : labels.follow}
        </Button>
      </div>
      {!operations.length && (
        <p className="text-muted-foreground">{labels.emptyTasks}</p>
      )}
      <ol>
        {operations.map((operation) => (
          <li key={operation.operationId}>
            <div>
              <span className="font-medium">{operation.actorId}</span>{" "}
              <span>{operation.actionId}</span>
            </div>
            <div className="text-muted-foreground">
              {operation.state}
              {operation.progress
                ? ` · ${operation.progress.completed}${operation.progress.total ? ` / ${operation.progress.total}` : ""} ${operation.progress.unit}`
                : ""}
            </div>
            {operation.errorCode && <p role="alert">{operation.errorCode}</p>}
            <Button
              size="sm"
              variant="ghost"
              disabled={
                !(canLocate
                  ? canLocate(operation)
                  : operation.revealTarget.sessionId)
              }
              aria-label={`${labels.locate} ${operation.operationId}`}
              onClick={() => onLocate(operation)}
            >
              {labels.locate}
            </Button>
            {readInput && (
              <OperationInputView
                operationId={operation.operationId}
                read={readInput}
                labels={labels}
              />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
