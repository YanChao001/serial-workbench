import type {
  FileTransferParams,
  FileTransferReceiptsParams,
  FileTransferReceiptsResult,
  Operation,
  Target,
} from "@serial-workbench/contracts";
import { parseU64, U64_MAX } from "@/lib/u64";
import { isRecord } from "@/lib/settings-model";
import { CommandSequenceError } from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-model";
import { commandVariablePattern } from "../../../packages/plugin-sdk/src/command-template";
import { confirmedTxRange } from "./send-history-model";

type RecordedRange = Required<Omit<FileTransferParams, "sourceRef">>;
export type RecordedFileStep = RecordedRange & { kind: "file"; input: string };
export type FileReceiptReader = (
  params: FileTransferReceiptsParams,
  signal: AbortSignal,
) => Promise<FileTransferReceiptsResult>;

const rangeKeys = [
  "offset",
  "length",
  "chunkBytes",
  "bytesPerSecond",
  "interChunkMs",
  "writeWaitMs",
] as const satisfies readonly (keyof RecordedRange)[];

function recordBounds(step: RecordedFileStep) {
  const offset = parseU64(step.offset);
  const length = parseU64(step.length);
  const chunk = parseU64(step.chunkBytes);
  const rate = parseU64(step.bytesPerSecond);
  const interval = parseU64(step.interChunkMs);
  const wait = parseU64(step.writeWaitMs);
  if (
    offset === undefined ||
    !length ||
    offset + length > U64_MAX ||
    !chunk ||
    chunk > 16_384n ||
    !rate ||
    rate > 16_777_216n ||
    interval === undefined ||
    interval > 2_147_483_647n ||
    !wait
  )
    return;
  return { offset, length, chunk };
}

export function parseRecordedFileStep(
  value: unknown,
  path: string,
): RecordedFileStep {
  if (
    !isRecord(value) ||
    value.kind !== "file" ||
    typeof value.input !== "string" ||
    !commandVariablePattern.test(value.input)
  )
    throw new CommandSequenceError(path, "Expected a named file input");
  const {
    offset,
    length,
    chunkBytes,
    bytesPerSecond,
    interChunkMs,
    writeWaitMs,
  } = value;
  if (
    typeof offset !== "string" ||
    typeof length !== "string" ||
    typeof chunkBytes !== "string" ||
    typeof bytesPerSecond !== "string" ||
    typeof interChunkMs !== "string" ||
    typeof writeWaitMs !== "string" ||
    Object.keys(value).some(
      (key) =>
        key !== "kind" &&
        key !== "input" &&
        !rangeKeys.some((option) => option === key),
    )
  )
    throw new CommandSequenceError(
      path,
      "Expected only the file input and send options",
    );
  const step: RecordedFileStep = {
    kind: "file",
    input: value.input,
    offset,
    length,
    chunkBytes,
    bytesPerSecond,
    interChunkMs,
    writeWaitMs,
  };
  if (!recordBounds(step))
    throw new CommandSequenceError(path, "Invalid file range or pacing");
  return step;
}

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
  const bounds = recordBounds(step);
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
