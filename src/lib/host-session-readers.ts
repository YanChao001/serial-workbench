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
import { nativeErrorCode } from "./native-error";
import { reportClientError } from "./report-error";
import { waitForHost } from "./host-native-transport";
function failure(code: string, message: string) {
  return new HostRequestError({ code, message, retryable: false });
}
class RemoteRawFailure extends Error {
  constructor(readonly original: unknown) {
    super("Remote Raw request failed");
  }
}
type ReaderResume = {
  view: HostStreamView;
  retained: Array<{ item: StreamItem; size: number }>;
  retainedBytes: number;
  cursor?: Cursor;
  recoveries: number;
};

export function createSessionReaders(
  connection: HostConnection,
  onUpdate: (sessionId: string, view: HostStreamView | undefined) => void,
  pendingAuthorization?: (
    session: SessionSnapshot,
  ) => Promise<unknown> | undefined,
) {
  let disposed = false;
  const readers = new Map<
    string,
    {
      epoch: string;
      controller: AbortController;
      listeners: Set<() => void>;
      snapshot: () => ReaderResume;
      authorizedAgain: () => void;
      failureCode: () => string | undefined;
      retire: () => void;
    }
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
    const value = await connection.transport
      .rawRequest({ method: "action.query", params: query }, signal)
      .catch((error: unknown) => {
        throw new RemoteRawFailure(error);
      });
    const reply = parseReply(value);
    if (!reply.ok)
      throw new RemoteRawFailure(new HostRequestError(reply.error));
    if (!("kind" in reply.result)) throw new ContractValidationError();
    return reply.result;
  }
  function startReader(
    session: SessionSnapshot,
    notifications: Set<() => void>,
    resume?: ReaderResume,
  ) {
    const controller = new AbortController();
    let authorizedAgain = false;
    let closed = session.state === "closed";
    let checkingTerminal = false;
    let terminalChecked = false;
    const originalHost = connection.attachment.hostId;
    const originalInstance = connection.attachment.instanceEpoch;
    const originalGeneration = connection.generation;
    const originalTarget = sessionTarget(session);
    const entry = {
      epoch: session.sessionEpoch,
      controller,
      listeners: notifications,
      authorizedAgain: () => {
        authorizedAgain = true;
      },
      failureCode: () => nativeErrorCode(view.error),
      retire: () => {
        closed = true;
        controller.abort();
      },
      snapshot: (): ReaderResume => ({
        view: { ...view, error: null },
        retained,
        retainedBytes,
        cursor: resumeCursor,
        recoveries: 0,
      }),
    };
    readers.set(session.sessionId, entry);
    const owned = () => !disposed && readers.get(session.sessionId) === entry;
    const current = () =>
      owned() && !closed && !checkingTerminal && !controller.signal.aborted;
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
      if (!owned()) return;
      onUpdate(session.sessionId, view);
      for (const notify of notifications) notify();
    };
    const fail = (error: unknown) => {
      if (!current()) return;
      if (
        error instanceof HostRequestError &&
        error.code === "PERMISSION_DENIED" &&
        (authorizedAgain ||
          pendingAuthorization?.(session) !== undefined ||
          ((authorized || resume !== undefined) && resumeCursor)) &&
        recoveries < 3
      ) {
        // 用户成功授权时旧初始读可能仍在途；只重新验权一次，不累积授权次数。
        // 已有游标按已处理位置接续，未获得过游标的旧读从新授权的当前位置开始。
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
      const numeric = (value: string) =>
        /^(0|[1-9][0-9]{0,19})$/.test(value) &&
        BigInt(value) <= 18446744073709551615n
          ? value
          : undefined;
      reportClientError(
        { message: nativeErrorCode(error) ?? "UNKNOWN" },
        JSON.stringify({
          scope: "Host raw reader",
          generation: numeric(connection.generation),
          instanceEpoch: numeric(connection.attachment.instanceEpoch),
          sessionEpoch: numeric(session.sessionEpoch),
        }),
      );
      view = {
        ...view,
        error: error instanceof Error ? error : new Error(String(error)),
      };
      publish();
      controller.abort();
    };
    const confirmClosedTerminal = (error: unknown) => {
      if (!current() || terminalChecked) return;
      terminalChecked = true;
      checkingTerminal = true;
      const confirmation = new AbortController();
      const abort = () => confirmation.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 5000);
      void (async () => {
        try {
          // Control 查询只执行一次；不把 Raw 终态或本地身份错误当作关闭完成。
          const reply = parseReply(
            await waitForHost(
              connection.transport.request(
                {
                  method: "action.query",
                  params: connection.buildQuery("session.get", originalTarget),
                },
                confirmation.signal,
              ),
              confirmation.signal,
            ),
          );
          if (
            !owned() ||
            closed ||
            controller.signal.aborted ||
            connection.generation !== originalGeneration ||
            connection.attachment.hostId !== originalHost ||
            connection.attachment.instanceEpoch !== originalInstance
          )
            return;
          if (
            reply.ok &&
            "kind" in reply.result &&
            reply.result.kind === "session" &&
            reply.result.value.sessionId === session.sessionId &&
            reply.result.value.sessionEpoch === session.sessionEpoch &&
            reply.result.value.state === "closed"
          ) {
            entry.retire();
            return;
          }
        } catch {
          // 不确定、失败或超时均保留原始 Raw 错误，不以查询错误替换。
        } finally {
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", abort);
        }
        checkingTerminal = false;
        fail(error);
      })();
    };
    const failRemoteRequest = (error: unknown) => {
      if (!(error instanceof RemoteRawFailure)) {
        fail(error);
        return;
      }
      const code = nativeErrorCode(error.original);
      if (code === "EPOCH_MISMATCH" || code === "BACKEND_DISCONNECTED")
        confirmClosedTerminal(error.original);
      else fail(error.original);
    };
    publish();
    if (closed) {
      controller.abort();
      return entry;
    }
    void (async () => {
      const pending = pendingAuthorization?.(session);
      if (pending) {
        // Open 的会话投影可能早于 Native 会话授权。等同设备的实际意图结束，
        // 再独立验权；失败也不自动授权、打开或发送。
        await waitForHost(
          pending.then(
            () => undefined,
            () => undefined,
          ),
          controller.signal,
        );
        if (!current()) return;
      }
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
      const channel = await connection.transport
        .openRawChannel(
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
            void credit().catch(failRemoteRequest);
          },
          (frame) => {
            if (!current()) return;
            if (
              frame.requestId !== request.requestId ||
              frame.channel !== "raw"
            )
              throw new ContractValidationError();
            if (frame.body.type === "subscriptionEnded") {
              if (
                identity.subscriptionId &&
                frame.body.subscriptionId !== identity.subscriptionId
              )
                throw new ContractValidationError(
                  "Raw lifecycle belongs to another subscription",
                );
              const error = new HostRequestError(frame.body.error);
              if (error.code === "EPOCH_MISMATCH") confirmClosedTerminal(error);
              else fail(error);
            } else if (frame.body.type === "error")
              fail(new HostRequestError(frame.body.error));
            else
              throw new ContractValidationError(
                "Unexpected raw lifecycle frame",
              );
          },
          controller.signal,
          fail,
        )
        .catch((error: unknown) => {
          throw new RemoteRawFailure(error);
        });
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
    })().catch(failRemoteRequest);
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
    /** 只在用户显式授权成功后恢复已停止的同代 reader，不重放任何写入。 */
    retryAuthorized(session: SessionSnapshot) {
      const reader = readers.get(session.sessionId);
      if (
        session.state === "closed" ||
        !reader ||
        reader.epoch !== session.sessionEpoch ||
        reader.listeners.size === 0
      )
        return;
      if (!reader.controller.signal.aborted) {
        reader.authorizedAgain();
        return;
      }
      if (reader.failureCode() !== "PERMISSION_DENIED") return;
      startReader(session, reader.listeners, reader.snapshot());
    },
    update(session: SessionSnapshot) {
      const reader = readers.get(session.sessionId);
      if (!reader) return;
      if (reader.epoch === session.sessionEpoch) {
        if (session.state === "closed") reader.retire();
        return;
      }
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
