import {
  ContractValidationError,
  parseWireFrame,
} from "@serial-workbench/contracts";
import type {
  Query,
  RawBatch,
  RpcRequest,
  StateScopeRef,
  Target,
  WireFrame,
} from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import type { HostTransport } from "@serial-workbench/host-client";
import type { DesktopAttachment } from "./generated/bindings";
import * as native from "./tauri";
export type HostNativePort = {
  attachment: typeof native.hostAttachment;
  request: typeof native.hostRequest;
  subscribe: typeof native.hostSubscribe;
  unsubscribe: typeof native.hostUnsubscribe;
  rawRequest: typeof native.hostRawRequest;
  rawSubscribe: typeof native.hostRawSubscribe;
  rawUnsubscribe: typeof native.hostRawUnsubscribe;
  ack: typeof native.hostDeliveryAck;
};
export const nativePort: HostNativePort = {
  attachment: native.hostAttachment,
  request: native.hostRequest,
  subscribe: native.hostSubscribe,
  unsubscribe: native.hostUnsubscribe,
  rawRequest: native.hostRawRequest,
  rawSubscribe: native.hostRawSubscribe,
  rawUnsubscribe: native.hostRawUnsubscribe,
  ack: native.hostDeliveryAck,
};
export function abortError(): DOMException {
  return new DOMException("Waiting was aborted", "AbortError");
}
export function waitForHost<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function failure(code: string, message: string) {
  return new HostRequestError({ code, message, retryable: false });
}
type ChannelHandle = { subscriptionId: string; unsubscribe: () => void };
export function createNativeTransport(
  desktop: DesktopAttachment,
  port: HostNativePort = nativePort,
) {
  const scopes = new Map<string, Target>();
  const closers = new Set<() => void>();
  let disposed = false;
  function channel<T>(
    start: (
      data: (value: T) => void,
      lifecycle: (value: WireFrame) => void,
    ) => Promise<string>,
    stop: (id: string) => Promise<void>,
    onData: (value: T, subscriptionId: string) => void,
    onLifecycle: (value: WireFrame, subscriptionId: string) => void,
    signal?: AbortSignal,
    onError: (error: Error) => void = () => {},
  ): Promise<ChannelHandle> {
    if (signal?.aborted || disposed) return Promise.reject(abortError());
    let id: string | undefined;
    let closed = false;
    let stopped = false;
    const streams = {
      data: { received: 0n, consumed: 0n, acknowledged: 0n, sending: false },
      lifecycle: {
        received: 0n,
        consumed: 0n,
        acknowledged: 0n,
        sending: false,
      },
    };
    let buffered: Array<() => void> = [];
    let bufferedBytes = 0;
    const close = () => {
      closed = true;
      signal?.removeEventListener("abort", close);
      closers.delete(close);
      if (id && !stopped) {
        stopped = true;
        void stop(id).catch(report);
      }
    };
    const report = (error: unknown) => {
      close();
      onError(error instanceof Error ? error : new Error(String(error)));
    };
    const acknowledge = (stream: "data" | "lifecycle") => {
      const state = streams[stream];
      if (!id || state.sending || state.consumed <= state.acknowledged) return;
      const ordinal = state.consumed;
      state.sending = true;
      void port.ack(desktop.generation, id, stream, ordinal.toString()).then(
        () => {
          state.acknowledged = ordinal;
          state.sending = false;
          acknowledge(stream);
        },
        (error) => {
          state.sending = false;
          report(error);
        },
      );
    };
    const consume = <V>(
      stream: "data" | "lifecycle",
      value: V,
      listener: (value: V, subscriptionId: string) => void,
    ) => {
      const state = streams[stream];
      const ordinal = ++state.received;
      const dispatch = () => {
        try {
          if (!closed && id) listener(value, id);
        } catch (error) {
          report(error);
        } finally {
          if (ordinal > state.consumed) state.consumed = ordinal;
          acknowledge(stream);
        }
      };
      if (id) {
        dispatch();
        return;
      }
      if (closed) {
        state.consumed = ordinal;
        return;
      }
      // The bridge also bounds pre-reply delivery; keep this client-side setup bounded.
      bufferedBytes += new TextEncoder().encode(
        JSON.stringify(value),
      ).byteLength;
      if (buffered.length >= 256 || bufferedBytes > 4 * 1024 * 1024) {
        report(failure("CURSOR_EXPIRED", "Host channel setup overflow"));
        buffered = [];
        streams.data.consumed = streams.data.received;
        streams.lifecycle.consumed = streams.lifecycle.received;
      } else if (!closed) buffered.push(dispatch);
      else state.consumed = ordinal;
    };
    closers.add(close);
    signal?.addEventListener("abort", close, { once: true });
    const pending = start(
      (value) => consume("data", value, onData),
      (value) => consume("lifecycle", value, onLifecycle),
    ).then(
      (subscriptionId) => {
        id = subscriptionId;
        if (closed || disposed || signal?.aborted) close();
        for (const dispatch of buffered) dispatch();
        buffered = [];
        acknowledge("data");
        acknowledge("lifecycle");
        if (closed) throw abortError();
        return { subscriptionId, unsubscribe: close };
      },
      (error) => {
        close();
        throw error;
      },
    );
    // Observe late completion even when the consumer stopped waiting.
    void pending.catch(() => {});
    return waitForHost(pending, signal);
  }
  const transport = {
    getAttachment: () => desktop.attachment,
    resolveScope(scopeId: string) {
      const target = scopes.get(scopeId);
      if (!target)
        throw failure("NOT_FOUND", "Host did not authorize this state scope");
      return target;
    },
    setScopes(values: StateScopeRef[]) {
      scopes.clear();
      for (const value of values) scopes.set(value.scopeId, value.target);
    },
    request(request: RpcRequest, signal?: AbortSignal) {
      if (disposed || signal?.aborted) return Promise.reject(abortError());
      return waitForHost(port.request(request), signal);
    },
    openChannel(
      request: Query,
      onFrame: (value: unknown) => void,
      signal?: AbortSignal,
    ) {
      return channel<WireFrame>(
        (data) => port.subscribe(request, data),
        port.unsubscribe,
        (value) => onFrame(parseWireFrame(value)),
        () => {},
        signal,
        (error) =>
          onFrame({
            channel: "state",
            requestId: request.requestId,
            body: {
              type: "error",
              error: {
                code: "CHANNEL_FAILED",
                message: error.message,
                retryable: false,
              },
            },
          }),
      );
    },
    openRawChannel(
      request: Query,
      onBatch: (value: RawBatch) => void,
      onLifecycle: (value: WireFrame) => void,
      signal?: AbortSignal,
      onError?: (error: Error) => void,
    ) {
      return channel<RawBatch>(
        (data, lifecycle) => port.rawSubscribe(request, data, lifecycle),
        port.rawUnsubscribe,
        (value, id) => {
          if (value.subscriptionId !== id)
            throw new ContractValidationError("Raw subscription changed");
          onBatch(value);
        },
        (value, id) => {
          const frame = parseWireFrame(value);
          if (
            frame.body.type === "subscriptionEnded" &&
            frame.body.subscriptionId !== id
          )
            throw new ContractValidationError("Raw subscription changed");
          onLifecycle(frame);
        },
        signal,
        onError,
      );
    },
    rawRequest(request: RpcRequest, signal?: AbortSignal) {
      if (disposed || signal?.aborted) return Promise.reject(abortError());
      return waitForHost(port.rawRequest(request), signal);
    },
    dispose() {
      disposed = true;
      for (const close of [...closers]) close();
    },
  } satisfies HostTransport & Record<string, unknown>;
  return transport;
}
