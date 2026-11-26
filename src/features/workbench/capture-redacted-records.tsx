import type { CaptureRecord } from "@serial-workbench/contracts";
import type { WorkbenchLabels } from "./labels";

export function CaptureRedactedRecords({
  records,
  labels,
}: {
  records: readonly CaptureRecord[];
  labels: WorkbenchLabels;
}) {
  return (
    <ul
      aria-label={labels.captureRedacted}
      className="workbench-redacted-records"
    >
      {records.map(({ recordOrdinal, entry }) => {
        if (entry.kind === "reader_gap") {
          return (
            <li key={recordOrdinal}>
              <div className="workbench-redacted-record-meta">
                <span>#{recordOrdinal}</span>
                <span>{labels.captureRedactedGap}</span>
                <span>
                  {entry.value.sessionId} @ {entry.value.sessionEpoch}
                </span>
                <span>
                  {labels.captureRedactedEvents} [
                  {entry.value.missingEventRange.start},{" "}
                  {entry.value.missingEventRange.end})
                </span>
              </div>
            </li>
          );
        }
        if (entry.kind !== "redacted") return null;
        const {
          result,
          byteRange,
          eventStart,
          eventEnd,
          sessionId,
          sessionEpoch,
        } = entry.value;
        return (
          <li key={recordOrdinal}>
            <div className="workbench-redacted-record-meta">
              <span>#{recordOrdinal}</span>
              {byteRange && (
                <span>
                  {byteRange.direction === "tx"
                    ? labels.captureRedactionTxAttempt
                    : "RX"}{" "}
                  [{byteRange.start}, {byteRange.end})
                </span>
              )}
              <span
                title={`${entry.value.hostId} @ ${entry.value.instanceEpoch}`}
              >
                {sessionId} @ {sessionEpoch}
              </span>
              <span>
                {labels.captureRedactedEvents} [{eventStart}, {eventEnd})
              </span>
            </div>
            {result.kind === "text" ? (
              <pre className="workbench-redacted-record-text">
                {result.text}
              </pre>
            ) : (
              <p className="text-muted-foreground">
                {labels.captureRedactionOmitted[result.reason]}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
