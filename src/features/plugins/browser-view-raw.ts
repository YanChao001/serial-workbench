import {
  ContractValidationError,
  parseReply,
  validateCursor,
  type Cursor,
  type RawBatch,
  type Query,
  type Target,
} from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import type { HostConnection } from "@/lib/host-client";

function sameScope(a: Cursor, b: Cursor) {
  return (
    a.hostId === b.hostId &&
    a.instanceEpoch === b.instanceEpoch &&
    a.scopeId === b.scopeId
  );
}

function invalid() {
  return new ContractValidationError("Plugin view stream changed");
}

export async function rawQuery(
  connection: HostConnection,
  action: string,
  target: Target,
  params: Query["params"],
  signal: AbortSignal,
) {
  const reply = parseReply(
    await connection.transport.rawRequest(
      {
        method: "action.query",
        params: connection.buildQuery(action, target, params),
      },
      signal,
    ),
  );
  if (!reply.ok) throw new HostRequestError(reply.error);
  if (!("kind" in reply.result)) throw invalid();
  return reply.result;
}

export async function readBrowserViewRaw(
  connection: HostConnection,
  target: Target,
  port: MessagePort,
  authorize: () => Promise<void>,
  fail: (error: unknown) => void,
  signal: AbortSignal,
) {
  const reference = await rawQuery(
    connection,
    "stream.cursor",
    target,
    {},
    signal,
  );
  if (
    reference.kind !== "stream_cursor" ||
    reference.value.target.sessionId !== target.sessionId ||
    reference.value.target.sessionEpoch !== target.sessionEpoch ||
    reference.value.cursor.hostId !== connection.attachment.hostId ||
    reference.value.cursor.instanceEpoch !==
      connection.attachment.instanceEpoch ||
    !target.sessionId ||
    !target.sessionEpoch
  )
    throw invalid();

  const beginning = { ...reference.value.cursor, position: "0" };
  const queue = BigInt(connection.attachment.limits.maxReaderQueueBytes);
  const windowBytes = queue < 524288n ? queue : 524288n;
  let granted = windowBytes;
  let after = beginning;
  let subscribed:
    Awaited<ReturnType<typeof connection.transport.openRawChannel>> | undefined;
  let waiting: { batch: RawBatch; initialGap: boolean } | undefined;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const batches: { batch: RawBatch; initialGap: boolean }[] = [];
  async function pump() {
    if (busy || waiting || !subscribed || signal.aborted || document.hidden)
      return;
    const next = batches.shift();
    if (!next) return;
    busy = true;
    try {
      if (next.batch.subscriptionId !== subscribed.subscriptionId)
        throw invalid();
      await authorize();
      signal.throwIfAborted();
      waiting = next;
      timer = setTimeout(() => fail(invalid()), 10000);
      port.postMessage({
        requestId: crypto.randomUUID(),
        channel: "raw",
        body: { type: "rawBatch", batch: next.batch },
      });
    } finally {
      busy = false;
    }
  }
  const advance = () => void pump().catch(fail);
  document.addEventListener("visibilitychange", advance, { signal });
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      batches.length = 0;
    },
    { once: true },
  );

  let incoming = after;
  for (let attempt = 0; attempt < 3; attempt++) {
    incoming = after;
    const query = connection.buildQuery("stream.subscribe", target, {
      scopeId: after.scopeId,
      after,
      queueBytes: queue.toString(),
      initialCreditBytes: windowBytes.toString(),
      overflowPolicy: "drop_with_gap",
    });
    try {
      subscribed = await connection.transport.openRawChannel(
        query,
        (batch) => {
          if (
            !sameScope(batch.cursor, incoming) ||
            !sameScope(batch.previousCursor, incoming) ||
            batch.previousCursor.position !== incoming.position ||
            BigInt(batch.cursor.position) <= BigInt(incoming.position)
          )
            throw invalid();
          if (
            batch.items.some((item) => {
              const source = item.kind === "source" ? item.event : item.gap;
              return (
                source.hostId !== incoming.hostId ||
                source.instanceEpoch !== incoming.instanceEpoch ||
                source.sessionId !== target.sessionId ||
                source.sessionEpoch !== target.sessionEpoch
              );
            })
          )
            throw invalid();
          incoming = batch.cursor;
          batches.push({ batch, initialGap: false });
          advance();
        },
        ({ body }) =>
          fail(
            body.type === "subscriptionEnded" || body.type === "error"
              ? new HostRequestError(body.error)
              : invalid(),
          ),
        signal,
        fail,
      );
      break;
    } catch (error) {
      if (
        !(error instanceof HostRequestError) ||
        error.code !== "CURSOR_EXPIRED"
      )
        throw error;
      const oldest: unknown = error.details.details?.oldestCursor;
      if (
        !validateCursor(oldest) ||
        !sameScope(oldest, after) ||
        BigInt(oldest.position) <= BigInt(after.position)
      )
        throw invalid();
      after = oldest;
    }
  }
  if (!subscribed) throw invalid();
  signal.throwIfAborted();
  const subscriptionId = subscribed.subscriptionId;
  if (after.position !== beginning.position) {
    batches.unshift({
      initialGap: true,
      batch: {
        subscriptionId,
        previousCursor: beginning,
        cursor: after,
        items: [
          {
            kind: "reader_gap",
            gap: {
              hostId: after.hostId,
              instanceEpoch: after.instanceEpoch,
              sessionId: target.sessionId,
              sessionEpoch: target.sessionEpoch,
              reason: "reader_overflow",
              missingEventRange: {
                start: "1",
                end: (BigInt(after.position) + 1n).toString(),
              },
            },
          },
        ],
      },
    });
  }

  async function ack(position: unknown) {
    if (busy || !waiting || waiting.batch.cursor.position !== position) return;
    const confirmed = waiting;
    clearTimeout(timer);
    waiting = undefined;
    busy = true;
    try {
      if (!confirmed.initialGap) {
        const ackCursor = confirmed.batch.cursor;
        async function credit(amount: bigint) {
          const reply = await rawQuery(
            connection,
            "stream.credit",
            target,
            {
              subscriptionId: confirmed.batch.subscriptionId,
              ackCursor,
              grantedBytesTotal: amount.toString(),
            },
            signal,
          );
          if (
            reply.kind !== "stream_credit" ||
            !sameScope(reply.value.ackCursor, ackCursor) ||
            reply.value.ackCursor.position !== ackCursor.position ||
            reply.value.grantedBytesTotal !== amount.toString() ||
            BigInt(reply.value.acknowledgedBytesTotal) >
              BigInt(reply.value.sentBytesTotal) ||
            BigInt(reply.value.sentBytesTotal) > amount
          )
            throw invalid();
          return BigInt(reply.value.acknowledgedBytesTotal);
        }
        await authorize();
        const next = (await credit(granted)) + windowBytes;
        if (next > granted) {
          await credit(next);
          granted = next;
        }
      }
    } finally {
      busy = false;
    }
    await pump();
  }
  port.onmessage = ({ data }: MessageEvent<unknown>) => {
    void ack(data).catch(fail);
  };
  await pump();
}
