import type {
  FileTransferReceiptsParams,
  FileTransferReceiptsResult,
  Operation,
  Target,
} from "@serial-workbench/contracts";
import { parseU64 } from "@/lib/u64";
import {
  recordedFileBounds,
  type RecordedFileStep,
} from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-file-model";
import { confirmedTxRange } from "./send-history-model";

export type { RecordedFileStep } from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-file-model";
export { parseRecordedFileStep } from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-file-model";

export type FileReceiptReader = (
  params: FileTransferReceiptsParams,
  signal: AbortSignal,
) => Promise<FileTransferReceiptsResult>;

function matchesTransfer(operation: Operation, target: Target) {
  return (
    operation.actionId === "transfer.file" &&
    operation.executionHostId === target.hostId &&
    operation.target.hostId === target.hostId &&
    operation.target.kind === "session" &&
    operation.target.id === target.id &&
    operation.target.sessionId === target.sessionId &&
    operation.target.sessionEpoch === target.sessionEpoch
  );
}

export async function confirmedFileWrite(
  admitted: Operation,
  settled: Operation,
  step: RecordedFileStep,
  target: Target,
  read: FileReceiptReader,
  signal: AbortSignal,
) {
  const bounds = recordedFileBounds(step);
  if (
    !bounds ||
    !matchesTransfer(admitted, target) ||
    !matchesTransfer(settled, target) ||
    settled.operationId !== admitted.operationId ||
    settled.actorId !== admitted.actorId ||
    settled.requestId !== admitted.requestId ||
    settled.state !== "succeeded" ||
    settled.result?.kind !== "file_transfer"
  )
    return;
  const { receiptsRef, requested, accepted, unknown } = settled.result.value;
  const { offset, length, chunk } = bounds;
  if (
    parseU64(requested) !== length ||
    parseU64(accepted) !== length ||
    parseU64(unknown) !== 0n ||
    receiptsRef.hostId !== target.hostId ||
    receiptsRef.kind !== "transfer_receipts" ||
    receiptsRef.id !== settled.operationId ||
    !parseU64(receiptsRef.revision)
  )
    return;
  const count = (length + chunk - 1n) / chunk;
  const lastOrdinal = count - 1n;

  async function readEdge(ordinal: bigint) {
    signal.throwIfAborted();
    const page = await read(
      {
        receiptsRef,
        startOrdinal: ordinal.toString(),
        maxReceipts: "1",
        maxBytes: "65536",
      },
      signal,
    );
    signal.throwIfAborted();
    const sourceAt = ordinal * chunk;
    const expectedLength = ordinal === lastOrdinal ? length - sourceAt : chunk;
    const [edge] = page.receipts;
    if (
      !page.sealed ||
      page.receiptsRef.hostId !== receiptsRef.hostId ||
      page.receiptsRef.id !== receiptsRef.id ||
      page.receiptsRef.kind !== receiptsRef.kind ||
      page.receiptsRef.revision !== receiptsRef.revision ||
      parseU64(page.count) !== count ||
      parseU64(page.nextOrdinal) !== ordinal + 1n ||
      page.hasMore !== ordinal < lastOrdinal ||
      page.receipts.length !== 1 ||
      !edge ||
      parseU64(edge.sourceOffset) !== offset + sourceAt ||
      edge.receipt.backendError
    )
      return;
    return confirmedTxRange(
      edge.receipt,
      settled.operationId,
      target,
      expectedLength,
    );
  }

  const first = readEdge(0n);
  const [start, end] = await Promise.all([
    first,
    lastOrdinal === 0n ? first : readEdge(lastOrdinal),
  ]);
  return start && end && end.end - start.start === length
    ? { start: start.start, end: end.end }
    : undefined;
}
