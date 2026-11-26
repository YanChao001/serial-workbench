import { isUtf8 } from "node:buffer";
import { EventEmitter, once } from "node:events";
import WebSocket from "ws";
import type {
  TransportMessage,
  TransportMessageConnection,
} from "@serial-workbench/plugin-sdk/node";
import { websocketMessageLimit, type WebsocketSendType } from "./endpoint.ts";

export const websocketLimits = {
  maxPayload: websocketMessageLimit,
  maxBufferedChunks: 512,
  maxFragments: 256,
  closeTimeout: 700,
  perMessageDeflate: false,
};
const maxQueuedMessages = 256;
const maxQueuedBytes = 1024 * 1024;

export async function waitForActivity(
  events: EventEmitter,
  waitMs: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (waitMs <= 0) return;
  const timeout = AbortSignal.timeout(waitMs);
  try {
    await once(events, "ready", { signal: AbortSignal.any([signal, timeout]) });
  } catch (error) {
    if (!timeout.aborted) throw error;
  }
  signal.throwIfAborted();
}

export function websocketConnection(
  socket: WebSocket,
  sendType: WebsocketSendType,
): TransportMessageConnection {
  const events = new EventEmitter();
  const incoming: TransportMessage[] = [];
  let queuedBytes = 0;
  let fault: Error | undefined;
  let closing = false;
  let closed = false;

  const stopped = new Promise<void>((resolve) => {
    socket.once("close", (code) => {
      if (!closing && ![1000, 1001, 1005].includes(code))
        fault ??= new Error("WebSocket peer closed abnormally: " + code);
      closed = true;
      events.emit("ready");
      resolve();
    });
  });
  socket.on("error", (error) => {
    fault ??= error;
    events.emit("ready");
  });
  socket.on("message", (data, binary) => {
    if (closing || fault) return;
    if (
      !Buffer.isBuffer(data) ||
      incoming.length >= maxQueuedMessages ||
      queuedBytes + data.length > maxQueuedBytes
    ) {
      fault = new Error("WebSocket receive queue limit reached");
      events.emit("ready");
      socket.close(1009);
      return;
    }
    queuedBytes += data.length;
    incoming.push({ bytes: data, messageType: binary ? "binary" : "text" });
    events.emit("ready");
  });

  function close() {
    if (!closing) {
      closing = true;
      socket.close(1000);
    }
    return stopped;
  }

  return {
    async readMessage({ maxBytes, waitMs, signal }) {
      signal.throwIfAborted();
      if (!incoming.length && !fault && !closed)
        await waitForActivity(events, waitMs, signal);
      const message = incoming.shift();
      if (message) {
        queuedBytes -= message.bytes.byteLength;
        if (message.bytes.byteLength > maxBytes)
          throw new Error("WebSocket message exceeds the receive budget");
        return message;
      }
      if (fault) throw fault;
      return closed ? null : undefined;
    },
    async write({ bytes, waitMs, signal }) {
      signal.throwIfAborted();
      const binary = sendType === "binary";
      if (
        closing ||
        socket.readyState !== WebSocket.OPEN ||
        bytes.byteLength > websocketMessageLimit ||
        (!binary && !isUtf8(bytes))
      )
        return 0;
      try {
        return await new Promise<number>((resolve, reject) => {
          let settled = false;
          function finish(error?: Error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolve(bytes.byteLength);
          }
          function abort() {
            finish(
              new Error("WebSocket write cancelled", { cause: signal.reason }),
            );
          }
          const timer = setTimeout(
            () => finish(new Error("WebSocket write timed out")),
            waitMs,
          );
          signal.addEventListener("abort", abort, { once: true });
          try {
            socket.send(bytes, { binary }, finish);
          } catch (error) {
            finish(new Error("WebSocket write failed", { cause: error }));
          }
        });
      } catch (error) {
        await close();
        throw error;
      }
    },
    close,
  };
}
