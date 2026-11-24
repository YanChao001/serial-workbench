import {
  TX_MAX_BYTES,
  type DeviceDescriptor,
  type Operation,
  type OperationSummary,
  type SessionSnapshot,
  type Target,
} from "@serial-workbench/contracts";
import { bytesToBase64 } from "@/lib/base64";
import { parseU64 } from "@/lib/u64";
import type { OperationInputReader } from "./operation-input";
import { decodeBytes } from "./stream-model";

const terminalStates = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
]);

export const maxHistoryBatch = 16;

export type SendHistoryRow = {
  operation: OperationSummary;
  port?: string;
};

export type HistoryPayload = {
  operationId: string;
  bytes: Uint8Array;
  bytesBase64: string;
};

export function historyRows(
  summaries: readonly OperationSummary[],
  sessions: readonly SessionSnapshot[],
  devices: readonly DeviceDescriptor[],
  hostId: string,
  pinned: ReadonlySet<string>,
): SendHistoryRow[] {
  const names = new Map(
    devices
      .filter((device) => device.hostId === hostId)
      .map((device) => [device.deviceId, device.systemName]),
  );
  const opened = new Map(
    summaries
      .filter(
        ({ actionId, state, executionHostId, target, revealTarget }) =>
          actionId === "device.open" &&
          state === "succeeded" &&
          executionHostId === hostId &&
          target.hostId === hostId &&
          target.kind === "device" &&
          revealTarget.sessionId !== undefined,
      )
      .map(({ target, revealTarget }) => [revealTarget.sessionId, target.id]),
  );
  return summaries
    .filter(
      ({ actionId, state, executionHostId, target }) =>
        actionId === "session.tx" &&
        terminalStates.has(state) &&
        executionHostId === hostId &&
        target.hostId === hostId &&
        target.kind === "session" &&
        target.id === target.sessionId &&
        target.sessionEpoch !== undefined,
    )
    .map((operation) => {
      const { sessionId, sessionEpoch } = operation.target;
      const deviceId =
        sessions.find(
          (session) =>
            session.sessionId === sessionId &&
            session.sessionEpoch === sessionEpoch,
        )?.deviceId ?? opened.get(sessionId);
      return {
        operation,
        port: deviceId ? (names.get(deviceId) ?? deviceId) : undefined,
      };
    })
    .sort(
      (left, right) =>
        Number(pinned.has(right.operation.operationId)) -
          Number(pinned.has(left.operation.operationId)) ||
        right.operation.acceptedAt.localeCompare(left.operation.acceptedAt) ||
        right.operation.operationId.localeCompare(left.operation.operationId),
    );
}

export function filterHistoryRows(
  rows: readonly SendHistoryRow[],
  search: string,
) {
  const query = search.trim().toLowerCase();
  if (!query) return rows;
  return rows.filter(({ operation, port }) =>
    [
      port,
      operation.target.sessionId,
      operation.target.sessionEpoch,
      operation.target.hostId,
      operation.operationId,
      operation.actorId,
      operation.state,
      operation.acceptedAt,
      operation.settledAt,
      operation.errorCode,
    ].some((value) => value?.toLowerCase().includes(query)),
  );
}

export async function readHistoryPayload(
  read: OperationInputReader,
  operationId: string,
  signal: AbortSignal,
): Promise<HistoryPayload> {
  signal.throwIfAborted();
  const input = await read(operationId, signal);
  signal.throwIfAborted();
  if (input.kind !== "tx") throw new SendHistoryError("unavailable");
  const { bytesBase64 } = input.value;
  if (bytesBase64.length > 4 * Math.ceil(TX_MAX_BYTES / 3))
    throw new SendHistoryError("unavailable");
  let bytes: Uint8Array;
  try {
    bytes = decodeBytes(bytesBase64);
  } catch {
    throw new SendHistoryError("unavailable");
  }
  if (
    !bytes.length ||
    bytes.length > TX_MAX_BYTES ||
    bytesToBase64(bytes) !== bytesBase64
  )
    throw new SendHistoryError("unavailable");
  return { operationId, bytes, bytesBase64 };
}

export class SendHistoryError extends Error {
  constructor(readonly reason: "unavailable" | "changed" | "unconfirmed") {
    super(reason);
  }
}

export function matchesSend(operation: Operation, target: Target) {
  return (
    operation.actionId === "session.tx" &&
    operation.executionHostId === target.hostId &&
    operation.target.hostId === target.hostId &&
    operation.target.kind === "session" &&
    operation.target.id === target.id &&
    operation.target.sessionId === target.sessionId &&
    operation.target.sessionEpoch === target.sessionEpoch
  );
}

export function confirmedSessionWrite(
  operation: Operation,
  planned: Pick<HistoryPayload, "bytes" | "bytesBase64">,
  target: Target,
) {
  if (
    !matchesSend(operation, target) ||
    operation.state !== "succeeded" ||
    operation.result?.kind !== "tx"
  )
    return;
  const result = operation.result.value;
  if (
    result.operationId !== operation.operationId ||
    result.sessionId !== target.sessionId ||
    result.sessionEpoch !== target.sessionEpoch ||
    result.outcome !== "accepted" ||
    result.bytesBase64 !== planned.bytesBase64 ||
    result.unknownRanges.length !== 0
  )
    return;
  const start = parseU64(result.byteStart);
  const end = parseU64(result.byteEnd);
  if (
    start === undefined ||
    end === undefined ||
    end - start !== BigInt(planned.bytes.length)
  )
    return;
  let cursor = start;
  for (const range of result.acceptedRanges) {
    const from = parseU64(range.start);
    const to = parseU64(range.end);
    if (from !== cursor || to === undefined || to <= cursor || to > end) return;
    cursor = to;
  }
  return cursor === end ? { start, end } : undefined;
}

export async function resendHistoryBatch({
  batch,
  target,
  read,
  send,
  wait,
  onAccepted,
  onConfirmed,
  signal,
}: {
  batch: readonly HistoryPayload[];
  target: Target;
  read: OperationInputReader;
  send: (bytes: Uint8Array, signal: AbortSignal) => Promise<Operation>;
  wait: (operation: Operation, signal: AbortSignal) => Promise<Operation>;
  onAccepted: (operationId: string) => void;
  onConfirmed: (operationId: string) => void;
  signal: AbortSignal;
}) {
  const ids = new Set(batch.map((item) => item.operationId));
  if (
    !batch.length ||
    batch.length > maxHistoryBatch ||
    ids.size !== batch.length
  )
    throw new SendHistoryError("unavailable");
  for (const item of batch) {
    const latest = await readHistoryPayload(read, item.operationId, signal);
    if (latest.bytesBase64 !== item.bytesBase64)
      throw new SendHistoryError("changed");
    signal.throwIfAborted();
    const accepted = await send(latest.bytes, signal);
    onAccepted(accepted.operationId);
    signal.throwIfAborted();
    if (!matchesSend(accepted, target))
      throw new SendHistoryError("unconfirmed");
    const settled = await wait(accepted, signal);
    signal.throwIfAborted();
    if (
      settled.operationId !== accepted.operationId ||
      !confirmedSessionWrite(settled, latest, target)
    )
      throw new SendHistoryError("unconfirmed");
    onConfirmed(settled.operationId);
  }
}
