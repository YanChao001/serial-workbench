import type { CaptureRecord, StreamItem } from "@serial-workbench/contracts";
export function captureRecordItems(
  records: readonly CaptureRecord[],
): StreamItem[] {
  return records.flatMap<StreamItem>((record) =>
    record.entry.kind === "event"
      ? [{ kind: "source", event: record.entry.value }]
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
