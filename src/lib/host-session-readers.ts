import {
  ContractValidationError,
  parseReply,
  parseWireFrame,
} from "@serial-workbench/contracts";
import type {
  Cursor,
  Query,
  SessionSnapshot,
  Target,
} from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import type { HostConnection } from "./host-client";
import type { HostStreamView } from "@/providers/host-context";
import { nativeErrorCode } from "./native-error";
import { reportClientError } from "./report-error";
import { waitForHost } from "./host-native-transport";
import { parseU64 } from "./u64";
import {
  ReceiveHistoryBuffer,
  receiveHistoryLimits,
  subscribeReceiveHistoryLimits,
  type ReceiveHistory,
} from "./receive-history";
function failure(code: string, message: string) {
  return new HostRequestError({ code, message, retryable: false });
}
class RemoteRawFailure extends Error {
  constructor(readonly original: unknown) {
    super("Remote Raw request failed");
  }
}
class RawReplyContractError extends ContractValidationError {
  constructor(readonly actionId: string) {
    super(`Invalid Host RPC reply (${actionId})`);
  }
}
type ReaderResume = {
  view: HostStreamView;
  history: ReceiveHistoryBuffer;
  cursor?: Cursor;
  recoveries: number;
};

export function createSessionReaders(
  connection: HostConnection,
  onUpdate: (sessionId: string, view: HostStreamView | undefined) => void,
  pendingAuthorization?: (
    session: SessionSnapshot,
  ) => Promise<unknown> | undefined,
  onConfirmedSession?: (session: SessionSnapshot) => void,
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
      observeRevision: (revision: SessionSnapshot["revision"]) => void;
      retire: () => void;
      resize: (limits: Readonly<ReceiveHistory>) => void;
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
    let reply: ReturnType<typeof parseReply>;
    try {
      reply = parseReply(value);
    } catch (error) {
      if (error instanceof ContractValidationError)
        throw new RawReplyContractError(query.actionId);
      throw error;
    }
    if (!reply.ok)
      throw new RemoteRawFailure(new HostRequestError(reply.error));
    if (!("kind" in reply.result))
      throw new RawReplyContractError(query.actionId);
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
    let latestRevision = session.revision;
    let checkingTerminal = false;
    let terminalChecked = false;
    const originalHost = connection.attachment.hostId;
    const originalInstance = connection.attachment.instanceEpoch;
    const originalGeneration = connection.generation;
    const originalTarget = sessionTarget(session);
    const history = resume?.history ?? new ReceiveHistoryBuffer();
    const entry = {
      epoch: session.sessionEpoch,
      controller,
      listeners: notifications,
      authorizedAgain: () => {
        authorizedAgain = true;
      },
      failureCode: () => nativeErrorCode(view.error),
      observeRevision: (revision: SessionSnapshot["revision"]) => {
        if (BigInt(revision) > BigInt(latestRevision))
          latestRevision = revision;
      },
      retire: () => {
        closed = true;
        controller.abort();
      },
      resize: (limits: Readonly<ReceiveHistory>) => {
        if (!owned() || !history.setLimits(limits)) return;
        view = {
          ...view,
          items: history.items(),
          trimmed: history.trimmed,
          removed: { ...history.removed },
        };
        publish();
      },
      snapshot: (): ReaderResume => ({
        view: { ...view, error: null },
        history,
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
          history,
          cursor: resumeCursor,
          recoveries: recoveries + 1,
        });
        return;
      }
      const numeric = (value: string) =>
        parseU64(value) !== undefined ? value : undefined;
      reportClientError(
        {
          message:
            nativeErrorCode(error) ??
            (error instanceof ContractValidationError
              ? "CONTRACT_INVALID"
              : "UNKNOWN"),
        },
        JSON.stringify({
          scope: "Host raw reader",
          actionId:
            error instanceof RawReplyContractError ? error.actionId : undefined,
          contractMessage:
            error instanceof ContractValidationError
              ? error.message
              : undefined,
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
            BigInt(reply.result.value.revision) >= BigInt(latestRevision) &&
            reply.result.value.state === "closed"
          ) {
            entry.retire();
            // 同一身份的 Control 证据也要更新连接控件，避免仍显示可发送/断开。
            onConfirmedSession?.(reply.result.value);
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
      if (
        code === "EPOCH_MISMATCH" ||
        code === "BACKEND_DISCONNECTED" ||
        code === "HOST_BUSY"
      )
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
        throw new RawReplyContractError("stream.cursor");
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
      let acknowledgedBytes = 0n;
      const maxBatch = BigInt(connection.attachment.limits.maxBatchBytes);
      const headroom = maxBatch < windowBytes ? maxBatch : windowBytes;
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
            grant = acknowledgedBytes + windowBytes;
            const acknowledged = await rawQuery(
              connection.buildQuery("stream.credit", target, {
                subscriptionId: identity.subscriptionId,
                ackCursor,
                grantedBytesTotal: grant.toString(),
              }),
              controller.signal,
            );
            if (acknowledged.kind !== "stream_credit")
              throw new RawReplyContractError("stream.credit");
            const receipt = acknowledged.value;
            const nextAcknowledged = BigInt(receipt.acknowledgedBytesTotal);
            const sent = BigInt(receipt.sentBytesTotal);
            if (
              receipt.ackCursor.hostId !== ackCursor.hostId ||
              receipt.ackCursor.instanceEpoch !== ackCursor.instanceEpoch ||
              receipt.ackCursor.scopeId !== ackCursor.scopeId ||
              receipt.ackCursor.position !== ackCursor.position ||
              BigInt(receipt.grantedBytesTotal) !== grant ||
              nextAcknowledged < acknowledgedBytes ||
              nextAcknowledged > sent ||
              sent > grant
            )
              throw new ContractValidationError(
                "Raw credit acknowledgement changed",
              );
            acknowledgedBytes = nextAcknowledged;
            // 下一次 ACK 携带上次 Host 会计确定的额度；只有不足一个最大批次时
            // 才单独补额度，避免逐个小读块固定进行两次 IPC 往返。
            if (
              !pendingCredit &&
              acknowledgedBytes + windowBytes > grant &&
              grant - sent < headroom
            )
              pendingCredit = ackCursor;
          }
        } finally {
          creditInFlight = false;
        }
      };
      const request = connection.buildQuery("stream.subscribe", target, {
        scopeId: cursor.scopeId,
        after: last,
        // queueBytes 同时承担当次 reader 的队列、待确认帧及编码内存，
        // 不能缩成 wire credit；碎片数据的内存开销远高于正文。
        queueBytes: queue.toString(),
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
            }
            history.append(batch.items);
            last = batch.cursor;
            resumeCursor = last;
            view = {
              ...view,
              items: history.items(),
              trimmed: history.trimmed,
              removed: { ...history.removed },
            };
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
              throw new ContractValidationError(
                `Raw lifecycle identity changed (${frame.channel}/${frame.body.type})`,
              );
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
  const unsubscribeLimits = subscribeReceiveHistoryLimits(() => {
    for (const reader of readers.values())
      reader.resize(receiveHistoryLimits());
  });
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
        reader.observeRevision(session.revision);
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
      unsubscribeLimits();
      for (const reader of readers.values()) reader.controller.abort();
      readers.clear();
    },
  };
}
