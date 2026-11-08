import { useEffect, useState } from "react";
import type { SessionMetrics, Target } from "@serial-workbench/contracts";
import type { HostContextValue } from "@/providers/host-context";
import type { WorkbenchLabels } from "./labels";

export function SessionMetricsView({
  read,
  target,
  attempt,
  labels,
}: {
  read: HostContextValue["sessionMetrics"];
  target: Target;
  attempt: number;
  labels: WorkbenchLabels;
}) {
  const [value, setValue] = useState<SessionMetrics>();
  const [error, setError] = useState<string>();
  const { hostId, sessionId, sessionEpoch } = target;
  useEffect(() => {
    const controller = new AbortController();
    let inflight = false;
    setValue(undefined);
    setError(undefined);
    const current: Target = {
      hostId,
      kind: "session",
      id: target.id,
      sessionId,
      sessionEpoch,
    };
    async function poll() {
      if (inflight || controller.signal.aborted) return;
      inflight = true;
      try {
        const result = await read(current, controller.signal);
        if (!controller.signal.aborted) {
          if (
            result.sessionId !== sessionId ||
            result.sessionEpoch !== sessionEpoch
          )
            throw new Error("EPOCH_MISMATCH");
          setValue(result);
          setError(undefined);
        }
      } catch (reason: unknown) {
        if (!controller.signal.aborted) {
          setValue(undefined);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        inflight = false;
      }
    }
    void poll();
    const interval = setInterval(() => void poll(), 1000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [read, hostId, target.id, sessionId, sessionEpoch, attempt]);
  const current =
    value?.sessionId === sessionId && value?.sessionEpoch === sessionEpoch
      ? value
      : undefined;
  return (
    <section aria-label={labels.sessionMetrics} className="space-y-2">
      <h3>{labels.sessionMetrics}</h3>
      {error && <p role="alert">{error}</p>}
      {current && (
        <dl className="workbench-transfer-result">
          <div>
            <dt>{labels.observedAt}</dt>
            <dd>{current.observedAt}</dd>
          </div>
          {(
            [
              "connectionDuration",
              "rxBytes",
              "txAcceptedBytes",
              "txUnknownBytes",
              "rxReadErrors",
              "txWriteErrors",
              "rxBytesPerSecond",
              "txAcceptedBytesPerSecond",
            ] as const
          ).map((field) => (
            <div key={field}>
              <dt>{labels[field]}</dt>
              <dd>
                {
                  current[
                    field === "connectionDuration"
                      ? "connectionDurationMs"
                      : field
                  ]
                }
              </dd>
            </div>
          ))}
          <div>
            <dt>{labels.lineErrors}</dt>
            <dd>{labels.metricUnavailable}</dd>
          </div>
          <div>
            <dt>{labels.frameCounts}</dt>
            <dd>{labels.metricUnavailable}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
