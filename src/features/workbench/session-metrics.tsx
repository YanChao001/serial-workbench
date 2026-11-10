import { useCallback } from "react";
import type { Target } from "@serial-workbench/contracts";
import type { HostContextValue } from "@/providers/host-context";
import type { WorkbenchLabels } from "./labels";
import { formatByteSize, formatElapsedTime } from "./metric-format";
import { useMetricsReader } from "./use-metrics-reader";
import { WorkbenchNotice } from "./workbench-notice";

export function SessionMetricsView({
  read,
  target,
  labels,
}: {
  read: HostContextValue["sessionMetrics"];
  target: Target;
  labels: WorkbenchLabels;
}) {
  const { hostId, sessionId, sessionEpoch } = target;
  const readCurrent = useCallback(
    async (signal?: AbortSignal) => {
      const current: Target = {
        hostId,
        kind: "session",
        id: target.id,
        sessionId,
        sessionEpoch,
      };
      const result = await read(current, signal);
      if (
        result.sessionId !== sessionId ||
        result.sessionEpoch !== sessionEpoch
      )
        throw { code: "EPOCH_MISMATCH" };
      return result;
    },
    [read, hostId, target.id, sessionId, sessionEpoch],
  );
  const { value, error } = useMetricsReader(readCurrent);
  const failure = error ? labels.operationText.failure(error.code) : undefined;
  const current =
    value?.sessionId === sessionId && value?.sessionEpoch === sessionEpoch
      ? value
      : undefined;
  return (
    <section aria-label={labels.sessionMetrics} className="space-y-2">
      <h3>{labels.sessionMetrics}</h3>
      <WorkbenchNotice
        noticeKey={JSON.stringify([
          hostId,
          sessionId,
          sessionEpoch,
          "metrics",
          error?.code,
        ])}
        log={
          failure
            ? {
                module: "serial",
                level: "error",
                code: error?.code,
                message: failure,
                context: labels.sessionMetrics,
              }
            : undefined
        }
      >
        {failure ? (
          <span role="alert">
            {labels.sessionMetrics}: {failure}
          </span>
        ) : null}
      </WorkbenchNotice>
      {current && (
        <dl className="workbench-metrics-values">
          <div>
            <dt>{labels.observedAt}</dt>
            <dd title={current.observedAt}>
              <time dateTime={current.observedAt}>
                {new Date(current.observedAt).toLocaleTimeString(undefined, {
                  hourCycle: "h23",
                })}
              </time>
            </dd>
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
          ).map((field) => {
            const raw =
              current[
                field === "connectionDuration" ? "connectionDurationMs" : field
              ];
            const display =
              raw === null
                ? "—"
                : field === "connectionDuration"
                  ? formatElapsedTime(raw)
                  : field === "rxBytesPerSecond" ||
                      field === "txAcceptedBytesPerSecond"
                    ? `${formatByteSize(raw)}/s`
                    : field === "rxBytes" ||
                        field === "txAcceptedBytes" ||
                        field === "txUnknownBytes"
                      ? formatByteSize(raw)
                      : new Intl.NumberFormat().format(BigInt(raw));
            return (
              <div key={field}>
                <dt>{labels[field]}</dt>
                <dd title={raw ?? undefined}>{display}</dd>
              </div>
            );
          })}
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
