import type { HostContextValue } from "@/providers/host-context";
import { SessionMetricsView } from "./session-metrics";
import type { HostMetrics, Target } from "@serial-workbench/contracts";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { WorkbenchLabels } from "./labels";
export type MetricsReader = (signal?: AbortSignal) => Promise<HostMetrics>;
export function MetricsPanel({
  read,
  readSession,
  target,
  contextKey,
  labels,
}: {
  read: MetricsReader;
  readSession?: HostContextValue["sessionMetrics"];
  target?: Target;
  contextKey?: string;
  labels: WorkbenchLabels;
}) {
  const [attempt, setAttempt] = useState(0);
  const [value, setValue] = useState<HostMetrics>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setValue(undefined);
    void read(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setValue(result);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [read, attempt]);
  return (
    <section
      aria-label={labels.metrics}
      className="workbench-metrics"
      aria-busy={loading}
    >
      <div className="workbench-toolbar">
        <h2>{labels.metrics}</h2>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => setAttempt((value) => value + 1)}
        >
          {labels.refresh}
        </Button>
      </div>
      {readSession && target && (
        <SessionMetricsView
          key={JSON.stringify([contextKey, target])}
          read={readSession}
          target={target}
          attempt={attempt}
          labels={labels}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {value && (
        <dl className="workbench-transfer-result">
          <div>
            <dt>{labels.observedAt}</dt>
            <dd>{value.observedAt}</dd>
          </div>
          <div>
            <dt>{labels.rss}</dt>
            <dd>{value.rssBytes}</dd>
          </div>
          <div>
            <dt>{labels.rssPeak}</dt>
            <dd>{value.rssPeakBytes}</dd>
          </div>
          {(
            [
              ["source", labels.sourceMemory],
              ["reader", labels.readerMemory],
              ["captureQueue", labels.captureMemory],
            ] as const
          ).map(([key, name]) => (
            <div key={key}>
              <dt>
                {name} ({labels.bytes})
              </dt>
              <dd>
                {value[key].usedBytes} / {value[key].limitBytes}
              </dd>
              <dd>
                {labels.peak}: {value[key].peakBytes}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
