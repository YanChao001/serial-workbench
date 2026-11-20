import type {
  ActivitySummary,
  OperationSummary,
} from "@serial-workbench/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  activities,
  includeUnlistedOperations = false,
  mcpClient,
  canLocateQuery,
  onMcpChange,
  onLocateQuery,
  labels,
  following,
  takeover,
  onFollowChange,
  onLocate,
  readInput,
  canLocate,
  currentActorId,
  describeTarget,
}: {
  operations: readonly OperationSummary[];
  activities?: readonly ActivitySummary[];
  includeUnlistedOperations?: boolean;
  mcpClient?: { actorId: string; name: string };
  canLocateQuery?: (activity: ActivitySummary) => boolean;
  onMcpChange: (value?: { actorId: string; name: string }) => void;
  onLocateQuery: (activity: ActivitySummary) => void;
  labels: WorkbenchLabels;
  following: boolean;
  takeover?: {
    label: string;
    pendingLabel: string;
    start: () => void;
    state?: "pending" | "done";
  };
  onFollowChange: (value: boolean) => void;
  onLocate: (operation: OperationSummary) => void;
  readInput?: OperationInputReader;
  canLocate?: (operation: OperationSummary) => boolean;
  currentActorId?: string;
  describeTarget?: (operation: OperationSummary) => string | undefined;
}) {
  const [showBackground, setShowBackground] = useState(false);
  const text = labels.operationText;
  const clients = new Map<string, string>();
  if (mcpClient) clients.set(mcpClient.actorId, mcpClient.name);
  for (const activity of activities ?? []) {
    if (activity.mcpClientId)
      clients.set(activity.actorId, activity.mcpClientId);
  }
  const summarized = new Set(operations.map((item) => item.operationId));
  const observed = (activities ?? [])
    .filter(
      (activity) =>
        activity.actorId === mcpClient?.actorId &&
        (!activity.operationId ||
          (includeUnlistedOperations && !summarized.has(activity.operationId))),
    )
    .reverse();
  const scopedOperations = mcpClient
    ? operations.filter((operation) => operation.actorId === mcpClient.actorId)
    : operations;
  const visible = scopedOperations.filter(
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
        {clients.size > 0 && (
          <Select
            value={mcpClient?.actorId ?? "none"}
            onValueChange={(actorId) => {
              const name = clients.get(actorId);
              onMcpChange(name ? { actorId, name } : undefined);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={labels.mcpClient}
              className="max-w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{labels.mcpUnbound}</SelectItem>
              {[...clients].map(([actorId, name]) => (
                <SelectItem key={actorId} value={actorId}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {mcpClient && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onFollowChange(!following)}
          >
            {following ? labels.pauseFollow : labels.follow}
          </Button>
        )}
        {takeover && (
          <Button
            size="sm"
            variant="outline"
            disabled={takeover.state === "pending"}
            onClick={takeover.start}
          >
            {takeover.label}
          </Button>
        )}
        {scopedOperations.some((operation) =>
          isBackgroundOperation(operation.actionId),
        ) && (
          <label className="workbench-inline-check">
            <input
              type="checkbox"
              checked={showBackground}
              onChange={(event) => setShowBackground(event.target.checked)}
            />
            {text.background}
          </label>
        )}
      </div>
      {takeover?.state && (
        <p role="status" className="text-muted-foreground">
          {takeover.state === "pending"
            ? takeover.pendingLabel
            : labels.takeoverDone}
        </p>
      )}
      {visible.length === 0 && observed.length === 0 && (
        <p className="text-muted-foreground">{labels.emptyTasks}</p>
      )}
      <ol>
        {observed.map((activity) => (
          <li key={activity.activityId}>
            <div>
              <time dateTime={activity.observedAt}>
                {new Date(activity.observedAt).toLocaleTimeString(undefined, {
                  hourCycle: "h23",
                })}
              </time>
              {" · "}
              {activity.mcpClientId}
              {" · "}
              <span className="font-medium">
                {operationName(activity.actionId, text)}
              </span>
              {activity.observations !== "1" && (
                <span> ×{activity.observations}</span>
              )}
            </div>
            {(canLocateQuery?.(activity) ??
              !!activity.revealTarget.sessionId) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onLocateQuery(activity)}
              >
                {labels.locate}
              </Button>
            )}
          </li>
        ))}
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
                  : (clients.get(operation.actorId) ?? text.otherClient)}
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
