import type { ByteRange, TxReceipt } from "@serial-workbench/contracts";
import type { WorkbenchLabels } from "./labels";

/** 接纳范围、未知范围与设备确认分别保留，不用操作成功替代传输事实。 */
export function TxReceiptFacts({
  receipt,
  labels,
}: {
  receipt: TxReceipt;
  labels: WorkbenchLabels;
}) {
  const start = BigInt(receipt.byteStart);
  const end = BigInt(receipt.byteEnd);
  const streamRange = (range: ByteRange) => ({
    start: start + BigInt(range.start),
    end: start + BigInt(range.end),
  });
  // Wire ranges are relative to this operation. The UI uses the TX stream's
  // offsets for every row so that the numbers can be compared and located.
  const accepted = receipt.acceptedRanges.map(streamRange);
  const unknown = receipt.unknownRanges.map(streamRange);
  const accountedFor = [...accepted, ...unknown].sort((left, right) =>
    left.start < right.start ? -1 : left.start > right.start ? 1 : 0,
  );
  const unaccepted: typeof accepted = [];
  let cursor = start;
  for (const range of accountedFor) {
    if (range.start > cursor)
      unaccepted.push({ start: cursor, end: range.start });
    if (range.end > cursor) cursor = range.end;
  }
  if (cursor < end) unaccepted.push({ start: cursor, end });

  return (
    <div className="workbench-tx-facts">
      <p>
        {labels.requestedBytes}: [{receipt.byteStart}, {receipt.byteEnd})
      </p>
      {accepted.map((range) => (
        <p key={`accepted-${range.start}`}>
          {labels.acceptedBytes}: [{range.start}, {range.end})
        </p>
      ))}
      {unknown.map((range) => (
        <p key={`unknown-${range.start}`}>
          {labels.unknownBytes}: [{range.start}, {range.end})
        </p>
      ))}
      {unaccepted.map((range) => (
        <p key={`unaccepted-${range.start}`}>
          {labels.unacceptedBytes}: [{range.start}, {range.end})
        </p>
      ))}
      <p>
        {receipt.peerAcknowledged
          ? labels.peerConfirmed
          : labels.peerUnconfirmed}
      </p>
      {receipt.backendError && <p>{receipt.backendError.code}</p>}
    </div>
  );
}
