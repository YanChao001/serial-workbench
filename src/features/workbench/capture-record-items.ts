import type { CaptureRecord } from "@serial-workbench/contracts";
import type { HistoryStreamItem } from "@/lib/receive-history";
export function captureRecordItems(
  records: readonly CaptureRecord[],
  preserveRecordBoundaries = false,
): HistoryStreamItem[] {
  return records.flatMap<HistoryStreamItem>((record) =>
    record.entry.kind === "event"
      ? [
          {
            kind: "source",
            event: record.entry.value,
            ...(preserveRecordBoundaries && {
              displayRecord: record.recordOrdinal,
            }),
          },
        ]
      : record.entry.kind === "reader_gap"
        ? [{ kind: "reader_gap", gap: record.entry.value }]
        : [],
  );
}

export function captureRecordSources(
  records: readonly CaptureRecord[],
): string[] {
  return [
    ...new Set(
      records.map((record) => {
        const value = record.entry.value;
        const session =
          record.entry.kind === "tx_settlement"
            ? record.entry.value.receipt
            : record.entry.value;
        return (
          value.hostId +
          " @ " +
          value.instanceEpoch +
          " / " +
          session.sessionId +
          " @ " +
          session.sessionEpoch
        );
      }),
    ),
  ];
}
