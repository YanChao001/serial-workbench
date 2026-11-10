import type { HostContextValue } from "@/providers/host-context";
import { SessionMetricsView } from "./session-metrics";
import type { HostMetrics, Target } from "@serial-workbench/contracts";
import { formatByteSize } from "./metric-format";
import { useMetricsReader } from "./use-metrics-reader";
import type { WorkbenchLabels } from "./labels";
import { WorkbenchNotice } from "./workbench-notice";
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
  const { value, error, loading } = useMetricsReader(read, contextKey);
  const failure = error ? labels.operationText.failure(error.code) : undefined;
  return (
    <section
      aria-label={labels.metrics}
      className="workbench-metrics"
      aria-busy={loading}
    >
      <h2 className="sr-only">{labels.metrics}</h2>
      <WorkbenchNotice
        noticeKey={JSON.stringify([contextKey, "metrics", error?.code])}
        log={
          failure
            ? {
                module: "application",
                level: "error",
                code: error?.code,
                message: failure,
                context: labels.metrics,
              }
            : undefined
        }
      >
        {failure ? (
          <span role="alert">
            {labels.metrics}: {failure}
          </span>
        ) : null}
      </WorkbenchNotice>
      {value && (
        <dl className="workbench-metrics-values">
          <div>
            <dt>{labels.observedAt}</dt>
            <dd title={value.observedAt}>
              <time dateTime={value.observedAt}>
                {new Date(value.observedAt).toLocaleTimeString(undefined, {
                  hourCycle: "h23",
                })}
              </time>
            </dd>
          </div>
          <div>
            <dt>{labels.rss}</dt>
            <dd title={value.rssBytes ?? undefined}>
              {formatByteSize(value.rssBytes)}
            </dd>
          </div>
          <div>
            <dt>{labels.rssPeak}</dt>
            <dd title={value.rssPeakBytes ?? undefined}>
              {formatByteSize(value.rssPeakBytes)}
            </dd>
          </div>
          {(
            [
              ["source", labels.sourceMemory],
              ["reader", labels.readerMemory],
              ["captureQueue", labels.captureMemory],
            ] as const
          ).map(([key, name]) => (
            <div key={key}>
              <dt>{name}</dt>
              <dd title={`${value[key].usedBytes} / ${value[key].limitBytes}`}>
                {formatByteSize(value[key].usedBytes)} /{" "}
                {formatByteSize(value[key].limitBytes)}
              </dd>
              <dd>
                {labels.peak}:{" "}
                <span title={value[key].peakBytes}>
                  {formatByteSize(value[key].peakBytes)}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {readSession &&
        target?.kind === "session" &&
        target.sessionId &&
        target.sessionEpoch && (
          <SessionMetricsView
            key={JSON.stringify([
              contextKey,
              target.hostId,
              target.kind,
              target.id,
              target.sessionId,
              target.sessionEpoch,
            ])}
            read={readSession}
            target={target}
            labels={labels}
          />
        )}
    </section>
  );
}
