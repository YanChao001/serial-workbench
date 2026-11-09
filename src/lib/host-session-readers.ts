import {
  ContractValidationError,
  parseReply,
  parseWireFrame,
} from "@serial-workbench/contracts";
import type {
  Cursor,
  Query,
  SessionSnapshot,
  StreamItem,
  Target,
} from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import type { HostConnection } from "./host-client";
import type { HostStreamView } from "@/providers/host-context";
function failure(code: string, message: string) {
  return new HostRequestError({ code, message, retryable: false });
}
type ReaderResume = {
  view: HostStreamView;
  retained: Array<{ item: StreamItem; size: number }>;
  retainedBytes: number;
  cursor: Cursor;
  recoveries: number;
};

export function createSessionReaders(
  connection: HostConnection,
  onUpdate: (sessionId: string, view: HostStreamView | undefined) => void,
) {
  let disposed = false;
  const readers = new Map<
    string,
    { epoch: string; controller: AbortController; listeners: Set<() => void> }
  >();
  function sessionTarget(session: SessionSnapshot): Target {
    return {
      hostId: connection.attachment.hostId,
      kind: "session",
      id: session.sessionId,
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
    };
  }
  async function rawQuery(query: Query, signal: AbortSignal) {
    const reply = parseReply(
      await connection.transport.rawRequest(
        { method: "action.query", params: query },
        signal,
      ),
    );
    if (!reply.ok) throw new HostRequestError(reply.error);
    if (!("kind" in reply.result)) throw new ContractValidationError();
    return reply.result;
  }
  function startReader(
    session: SessionSnapshot,
    notifications: Set<() => void>,
    resume?: ReaderResume,
  ) {
    const controller = new AbortController();
    const entry = {
      epoch: session.sessionEpoch,
      controller,
      listeners: notifications,
    };
    readers.set(session.sessionId, entry);
    const current = () =>
      !disposed &&
      !controller.signal.aborted &&
      readers.get(session.sessionId) === entry;
    let view: HostStreamView = resume?.view ?? {
      items: [],
      error: null,
      trimmed: false,
    };
    const retained = resume?.retained ?? [];
    let retainedBytes = resume?.retainedBytes ?? 0;
    let resumeCursor = resume?.cursor;
    let recoveries = resume?.recoveries ?? 0;
    let authorized = false;
    const publish = () => {
      if (!current()) return;
      onUpdate(session.sessionId, view);
      for (const notify of notifications) notify();
    };
    const fail = (error: unknown) => {
      if (!current()) return;
      if (
        error instanceof HostRequestError &&
        error.code === "PERMISSION_DENIED" &&
        (authorized || resume !== undefined) &&
        resumeCursor &&
        recoveries < 3
      ) {
        // 授权代次变化结束旧 reader；只用新查询重新验权，再从已处理游标接续。
        controller.abort();
        startReader(session, notifications, {
          view,
          retained,
          retainedBytes,
          cursor: resumeCursor,
          recoveries: recoveries + 1,
        });
        return;
      }
      view = {
        ...view,
        error: error instanceof Error ? error : new Error(String(error)),
      };
      publish();
      controller.abort();
    };
    publish();
    void (async () => {
      const reference = await rawQuery(
        connection.buildQuery("stream.cursor", sessionTarget(session)),
        controller.signal,
      );
      if (reference.kind !== "stream_cursor")
        throw new ContractValidationError();
      if (!current()) return;
      const { target, cursor } = reference.value;
      if (
        target.sessionId !== session.sessionId ||
        target.sessionEpoch !== session.sessionEpoch ||
        cursor.hostId !== connection.attachment.hostId ||
        cursor.instanceEpoch !== connection.attachment.instanceEpoch
      )
        throw new ContractValidationError(
          "Raw cursor belongs to another attachment",
        );
      const queue = BigInt(connection.attachment.limits.maxReaderQueueBytes);
      const windowBytes = queue < 1048576n ? queue : 1048576n;
      let grant = windowBytes;
      let last = resumeCursor ?? cursor;
      if (
        last.hostId !== cursor.hostId ||
        last.instanceEpoch !== cursor.instanceEpoch ||
        last.scopeId !== cursor.scopeId
      )
        throw failure("EPOCH_MISMATCH", "Raw stream source changed");
      resumeCursor = last;
      authorized = true;
      const identity: { subscriptionId?: string } = {};
      let pendingCredit: Cursor | undefined;
      let creditInFlight = false;
      const credit = async () => {
        if (creditInFlight || !identity.subscriptionId) return;
        creditInFlight = true;
        try {
          while (pendingCredit && current()) {
            const ackCursor = pendingCredit;
            pendingCredit = undefined;
            const acknowledged = await rawQuery(
              connection.buildQuery("stream.credit", target, {
                subscriptionId: identity.subscriptionId,
                ackCursor,
                grantedBytesTotal: grant.toString(),
              }),
              controller.signal,
            );
            if (acknowledged.kind !== "stream_credit")
              throw new ContractValidationError();
            grant =
              BigInt(acknowledged.value.acknowledgedBytesTotal) + windowBytes;
            await rawQuery(
              connection.buildQuery("stream.credit", target, {
                subscriptionId: identity.subscriptionId,
                ackCursor,
                grantedBytesTotal: grant.toString(),
              }),
              controller.signal,
            );
          }
        } finally {
          creditInFlight = false;
        }
      };
      const request = connection.buildQuery("stream.subscribe", target, {
        scopeId: cursor.scopeId,
        after: last,
        queueBytes: windowBytes.toString(),
        initialCreditBytes: windowBytes.toString(),
        overflowPolicy: "drop_with_gap",
      });
      const channel = await connection.transport.openRawChannel(
        request,
        (batch) => {
          if (!current()) return;
          const frame = parseWireFrame({
            requestId: request.requestId,
            channel: "raw",
            body: { type: "rawBatch", batch },
          });
          if (frame.body.type !== "rawBatch")
            throw new ContractValidationError();
          if (
            identity.subscriptionId &&
            batch.subscriptionId !== identity.subscriptionId
          )
            throw new ContractValidationError("Raw subscription changed");
          if (
            batch.cursor.hostId !== last.hostId ||
            batch.cursor.instanceEpoch !== last.instanceEpoch ||
            batch.cursor.scopeId !== last.scopeId ||
            batch.previousCursor.position !== last.position
          )
            throw failure("CURSOR_EXPIRED", "Raw stream cursor gap");
          for (const item of batch.items) {
            const identity = item.kind === "source" ? item.event : item.gap;
            if (
              identity.sessionId !== session.sessionId ||
              identity.sessionEpoch !== session.sessionEpoch ||
              identity.hostId !== cursor.hostId ||
              identity.instanceEpoch !== cursor.instanceEpoch
            )
              throw failure("EPOCH_MISMATCH", "Raw stream session changed");
            const size = new TextEncoder().encode(
              JSON.stringify(item),
            ).byteLength;
            retained.push({ item, size });
            retainedBytes += size;
            while (retained.length > 1024 || retainedBytes > 1048576) {
              const removed = retained.shift();
              if (removed) retainedBytes -= removed.size;
              view = { ...view, trimmed: true };
            }
          }
          last = batch.cursor;
          resumeCursor = last;
          view = { ...view, items: retained.map((value) => value.item) };
          publish();
          pendingCredit = batch.cursor;
          void credit().catch(fail);
        },
        (frame) => {
          if (!current()) return;
          if (frame.requestId !== request.requestId || frame.channel !== "raw")
            throw new ContractValidationError();
          if (
            frame.body.type === "subscriptionEnded" ||
            frame.body.type === "error"
          )
            fail(new HostRequestError(frame.body.error));
          else
            throw new ContractValidationError("Unexpected raw lifecycle frame");
        },
        controller.signal,
        fail,
      );
      identity.subscriptionId = channel.subscriptionId;
      if (!current()) {
        channel.unsubscribe();
        return;
      }
      controller.signal.addEventListener("abort", channel.unsubscribe, {
        once: true,
      });
      await credit();
      if (current()) recoveries = 0;
    })().catch(fail);
    return entry;
  }
  function watch(session: SessionSnapshot, listener: () => void): () => void {
    const sessionId = session.sessionId;
    if (disposed) return () => {};
    const notify = () => listener();
    const existing = readers.get(sessionId);
    const entry = existing ?? startReader(session, new Set());
    entry.listeners.add(notify);
    return () => {
      const current = readers.get(sessionId);
      if (!current) return;
      current.listeners.delete(notify);
      if (current.listeners.size === 0) {
        current.controller.abort();
        readers.delete(sessionId);
        onUpdate(sessionId, undefined);
      }
    };
  }
  return {
    watch,
    update(session: SessionSnapshot) {
      const reader = readers.get(session.sessionId);
      if (!reader || reader.epoch === session.sessionEpoch) return;
      reader.controller.abort();
      readers.delete(session.sessionId);
      onUpdate(session.sessionId, undefined);
      if (reader.listeners.size > 0) startReader(session, reader.listeners);
    },
    dispose() {
      disposed = true;
      for (const reader of readers.values()) reader.controller.abort();
      readers.clear();
    },
  };
}
