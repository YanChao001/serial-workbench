import type { OperationSummary } from "@serial-workbench/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { WorkbenchLabels } from "./labels";
import { OperationDetails } from "./operation-details";
import {
  isBackgroundOperation,
  operationName,
  operationProgress,
} from "./operation-text";
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
  currentActorId,
  describeTarget,
}: {
  operations: readonly OperationSummary[];
  labels: WorkbenchLabels;
  following: boolean;
  onFollowChange: (value: boolean) => void;
  onLocate: (operation: OperationSummary) => void;
  readInput?: OperationInputReader;
  canLocate?: (operation: OperationSummary) => boolean;
  currentActorId?: string;
  describeTarget?: (operation: OperationSummary) => string | undefined;
}) {
  const [showBackground, setShowBackground] = useState(false);
  const text = labels.operationText;
  const visible = operations.filter(
    (operation) => showBackground || !isBackgroundOperation(operation.actionId),
  );
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
        <label className="workbench-inline-check">
          <input
            type="checkbox"
            checked={showBackground}
            onChange={(event) => setShowBackground(event.target.checked)}
          />
          {text.background}
        </label>
      </div>
      {!visible.length && (
        <p className="text-muted-foreground">{labels.emptyTasks}</p>
      )}
      <ol>
        {visible.map((operation) => (
          <li key={operation.operationId}>
            <div>
              <time
                dateTime={operation.acceptedAt}
                title={operation.acceptedAt}
              >
                {new Date(operation.acceptedAt).toLocaleTimeString(undefined, {
                  hourCycle: "h23",
                })}
              </time>{" "}
              <span>
                {operation.actorId === currentActorId
                  ? text.thisClient
                  : text.otherClient}
              </span>
              {" · "}
              {describeTarget?.(operation) && (
                <span>{describeTarget(operation)} · </span>
              )}
              <span className="font-medium">
                {operationName(operation.actionId, text)}
              </span>
            </div>
            <div className="text-muted-foreground">
              {text.states[operation.state]}
              {operation.progress
                ? ` · ${operationProgress(operation.progress, text)}`
                : ""}
            </div>
            {operation.errorCode && <p>{text.failure(operation.errorCode)}</p>}
            <div className="workbench-toolbar">
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
              <OperationDetails operation={operation} label={text.details}>
                {readInput && (
                  <OperationInputView
                    operationId={operation.operationId}
                    actionId={operation.actionId}
                    read={readInput}
                    labels={labels}
                  />
                )}
              </OperationDetails>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
