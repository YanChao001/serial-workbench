import {
  ContractValidationError,
  parseReply,
  parseWireFrame,
} from "@serial-workbench/contracts";
import type {
  AttachResult,
  Call,
  Delta,
  HostError,
  Operation,
  Query,
  QueryResult,
  RpcRequest,
  Snapshot,
  Target,
} from "@serial-workbench/contracts";
import { createProjection } from "./projection";

export type HostTransport = {
  getAttachment(): AttachResult;
  resolveScope(scopeId: string): Target;
  request(request: RpcRequest, signal?: AbortSignal): Promise<unknown>;
  openChannel(
    request: Query,
    onFrame: (value: unknown) => void,
    signal?: AbortSignal,
  ): Promise<{ subscriptionId: string; unsubscribe: () => void }>;
};
export class HostRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: HostError;
  constructor(error: HostError) {
    super(error.message);
    this.name = "HostRequestError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error;
  }
}
export class ProjectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectionError";
  }
}
export type ProjectionEvent =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "delta"; delta: Delta }
  | { type: "error"; error: Error };
export type HostClient = {
  query(query: Query, signal?: AbortSignal): Promise<QueryResult>;
  invoke(call: Call, signal?: AbortSignal): Promise<Operation>;
  subscribe(
    scopeId: string,
    listener: (event: ProjectionEvent) => void,
    signal?: AbortSignal,
  ): Promise<() => void>;
};
function abortError(): DOMException {
  return new DOMException("Waiting was aborted", "AbortError");
}
async function waitFor<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The request may have started and rejected while obtaining this promise.
    void promise.catch(() => {});
    throw abortError();
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export function createHostClient(transport: HostTransport): HostClient {
  async function send(request: RpcRequest, signal?: AbortSignal) {
    if (signal?.aborted) throw abortError();
    const reply = parseReply(
      await waitFor(transport.request(request, signal), signal),
    );
    if (!reply.ok) throw new HostRequestError(reply.error);
    return reply.result;
  }
  async function query(
    query: Query,
    signal?: AbortSignal,
  ): Promise<QueryResult> {
    const result = await send(
      { method: "action.query", params: query },
      signal,
    );
    if (!("kind" in result)) throw new ContractValidationError();
    return result;
  }
  return {
    query,
    async invoke(call, signal) {
      const result = await send(
        { method: "action.invoke", params: call },
        signal,
      );
      if (!("operation" in result)) throw new ContractValidationError();
      return result.operation;
    },
    async subscribe(scopeId, listener, signal) {
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      let generation = 0;
      const close = () => {
        if (closed) return;
        closed = true;
        generation++;
        signal?.removeEventListener("abort", close);
        unsubscribe?.();
        unsubscribe = undefined;
      };
      if (signal?.aborted) throw abortError();
      signal?.addEventListener("abort", close, { once: true });
      async function start(recoveryAttempts = 0): Promise<void> {
        const thisGeneration = ++generation;
        let recoveries = recoveryAttempts;
        const attachment = transport.getAttachment();
        const target = transport.resolveScope(scopeId);
        const makeQuery = (
          actionId: string,
          params: Query["params"],
        ): Query => ({
          protocolVersion: attachment.protocolVersion,
          hostId: attachment.hostId,
          instanceEpoch: attachment.instanceEpoch,
          actorId: attachment.actorId,
          requestId: crypto.randomUUID(),
          actionId,
          target,
          params,
          revealTarget: { pageId: "workbench" },
        });
        let result: QueryResult;
        try {
          result = await query(
            makeQuery("state.snapshot", { scopeId }),
            signal,
          );
        } catch (error) {
          // 恢复查询也可能撞上下一次授权变更，继续消耗同一预算重新验权。
          if (
            !closed &&
            recoveries < 3 &&
            error instanceof HostRequestError &&
            error.code === "PERMISSION_DENIED"
          )
            return start(recoveries + 1);
          throw error;
        }
        if (closed || generation !== thisGeneration) return;
        if (result.kind !== "snapshot") throw new ContractValidationError();
        const snapshot = result.value;
        const current = transport.getAttachment();
        if (
          snapshot.hostId !== attachment.hostId ||
          snapshot.instanceEpoch !== attachment.instanceEpoch ||
          snapshot.cursor.hostId !== attachment.hostId ||
          snapshot.cursor.instanceEpoch !== attachment.instanceEpoch ||
          snapshot.cursor.scopeId !== scopeId ||
          current.hostId !== attachment.hostId ||
          current.instanceEpoch !== attachment.instanceEpoch ||
          current.actorId !== attachment.actorId ||
          current.clientId !== attachment.clientId
        )
          throw new ProjectionError(
            "ATTACHMENT_CHANGED",
            "Host attachment or snapshot changed",
          );
        const projection = createProjection(snapshot);
        listener({ type: "snapshot", snapshot });
        if (closed) return;
        const subscriptionQuery = makeQuery("state.subscribe", {
          scopeId,
          after: snapshot.cursor,
        });
        const channelState: { subscriptionId?: string } = {};
        let setupCompleted = false;
        const buffered: unknown[] = [];
        const fail = (error: Error) => {
          if (!closed && generation === thisGeneration) {
            close();
            listener({ type: "error", error });
          }
        };
        const recover = (error: Error) => {
          if (closed || generation !== thisGeneration) return;
          if (recoveries >= 3) {
            fail(error);
            return;
          }
          generation++;
          unsubscribe?.();
          unsubscribe = undefined;
          void start(recoveries + 1).catch((error: unknown) => {
            if (!closed) {
              close();
              listener({
                type: "error",
                error:
                  error instanceof Error ? error : new Error(String(error)),
              });
            }
          });
        };
        const onFrame = (value: unknown) => {
          if (closed || generation !== thisGeneration) return;
          const latest = transport.getAttachment();
          if (
            latest.hostId !== attachment.hostId ||
            latest.instanceEpoch !== attachment.instanceEpoch ||
            latest.actorId !== attachment.actorId ||
            latest.clientId !== attachment.clientId
          ) {
            fail(
              new ProjectionError(
                "ATTACHMENT_CHANGED",
                "Host attachment changed",
              ),
            );
            return;
          }
          if (!channelState.subscriptionId) {
            if (buffered.length >= 256)
              fail(
                new ProjectionError(
                  "STATE_BUFFER_OVERFLOW",
                  "State channel setup overflow",
                ),
              );
            else buffered.push(value);
            return;
          }
          try {
            const frame = parseWireFrame(value);
            if (
              frame.channel !== "state" ||
              frame.requestId !== subscriptionQuery.requestId
            )
              throw new ContractValidationError("Invalid Host state frame");
            if (frame.body.type === "error") {
              fail(new HostRequestError(frame.body.error));
              return;
            }
            if (
              !(
                frame.body.type === "delta" ||
                frame.body.type === "subscriptionEnded"
              ) ||
              frame.body.subscriptionId !== channelState.subscriptionId
            )
              throw new ContractValidationError("Invalid Host state frame");
            if (frame.body.type === "subscriptionEnded") {
              if (
                frame.body.error.code === "CURSOR_EXPIRED" ||
                frame.body.error.code === "PERMISSION_DENIED"
              )
                recover(new HostRequestError(frame.body.error));
              else fail(new HostRequestError(frame.body.error));
              return;
            }
            const disposition = projection.accept(frame.body.delta);
            if (disposition === "gap")
              recover(new ProjectionError("CURSOR_GAP", "State cursor gap"));
            else if (disposition === "applied") {
              if (setupCompleted) recoveries = 0;
              listener({ type: "delta", delta: frame.body.delta });
            }
          } catch {
            fail(
              new ProjectionError(
                "INVALID_STATE_FRAME",
                "Invalid Host state frame",
              ),
            );
          }
        };
        const pending = transport.openChannel(
          subscriptionQuery,
          onFrame,
          signal,
        );
        pending.then(
          (channel) => {
            if (closed || generation !== thisGeneration) channel.unsubscribe();
          },
          () => {},
        );
        let channel: Awaited<typeof pending>;
        try {
          channel = await waitFor(pending, signal);
        } catch (error) {
          if (
            !closed &&
            error instanceof HostRequestError &&
            (error.code === "CURSOR_EXPIRED" ||
              error.code === "PERMISSION_DENIED") &&
            recoveries < 3
          ) {
            return start(recoveries + 1);
          }
          throw error;
        }
        if (closed || generation !== thisGeneration) return;
        channelState.subscriptionId = channel.subscriptionId;
        unsubscribe = channel.unsubscribe;
        for (const frame of buffered) onFrame(frame);
        // 新快照与订阅均重新验权；成功建立的空闲订阅不累计过去的恢复。
        // setup 内连续结束仍由上面的同一恢复预算限制，旧队列绝不重新使用。
        if (!closed && generation === thisGeneration) {
          setupCompleted = true;
          recoveries = 0;
        }
      }
      try {
        await start();
      } catch (error) {
        close();
        throw error;
      }
      if (closed) throw abortError();
      return close;
    },
  };
}
