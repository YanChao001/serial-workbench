import type { TxReceipt } from "@serial-workbench/contracts";
import type { WorkbenchLabels } from "./labels";

/** 接纳范围、未知范围与设备确认分别保留，不用操作成功替代传输事实。 */
export function TxReceiptFacts({
  receipt,
  labels,
}: {
  receipt: TxReceipt;
  labels: WorkbenchLabels;
}) {
  return (
    <div className="workbench-tx-facts">
      <p>
        {labels.requestedBytes}: [{receipt.byteStart}, {receipt.byteEnd})
      </p>
      {receipt.acceptedRanges.map((range) => (
        <p key={`accepted-${range.start}`}>
          {labels.acceptedBytes}: [{range.start}, {range.end})
        </p>
      ))}
      {receipt.unknownRanges.map((range) => (
        <p key={`unknown-${range.start}`}>
          {labels.unknownBytes}: [{range.start}, {range.end})
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
