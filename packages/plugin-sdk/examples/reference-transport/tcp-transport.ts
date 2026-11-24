import { once, type EventEmitter } from "node:events";
import { createConnection, createServer, isIP, type Socket } from "node:net";
import type {
  NodeRegister,
  TransportConnection,
} from "@serial-workbench/plugin-sdk/node";

import { defaultTcpHost, tcpHostPattern } from "./tcp-endpoint.ts";

function waitForEvent(
  source: EventEmitter,
  events: readonly string[],
  waitMs: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      clearTimeout(timeout);
      for (const event of events) source.off(event, ready);
      signal.removeEventListener("abort", aborted);
    }
    function ready() {
      cleanup();
      resolve();
    }
    function aborted() {
      cleanup();
      reject(signal.reason);
    }

    const timeout = setTimeout(ready, waitMs);
    for (const event of events) source.once(event, ready);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function socketConnection(socket: Socket): TransportConnection {
  let fault: Error | undefined;
  socket.on("error", (error) => {
    fault = error;
  });
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
  function close() {
    socket.destroy();
    return closed;
  }

  return {
    async read({ maxBytes, waitMs, signal }) {
      signal.throwIfAborted();
      if (
        !socket.readableLength &&
        !socket.readableEnded &&
        !socket.destroyed &&
        !fault
      )
        await waitForEvent(
          socket,
          ["readable", "end", "close", "error"],
          waitMs,
          signal,
        );
      signal.throwIfAborted();
      const available = Math.min(socket.readableLength, maxBytes);
      if (available > 0) {
        const bytes: unknown = socket.read(available);
        if (!Buffer.isBuffer(bytes)) throw new Error("Invalid TCP input");
        return bytes;
      }
      if (fault) throw fault;
      return socket.readableEnded || socket.destroyed ? null : new Uint8Array();
    },
    async write({ bytes, waitMs, signal }) {
      signal.throwIfAborted();
      if (socket.destroyed || socket.writableEnded) return 0;
      try {
        return await new Promise<number>((resolve, reject) => {
          function complete(error?: Error | null) {
            clearTimeout(timeout);
            signal.removeEventListener("abort", aborted);
            if (error) reject(error);
            else resolve(bytes.byteLength);
          }
          function aborted() {
            complete(
              new Error("TCP write cancelled", { cause: signal.reason }),
            );
          }

          const timeout = setTimeout(
            () => complete(new Error("TCP write completion timed out")),
            waitMs,
          );
          signal.addEventListener("abort", aborted, { once: true });
          try {
            socket.write(bytes, complete);
          } catch (error) {
            complete(new Error("TCP write failed", { cause: error }));
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

async function connect(host: string, port: number, signal: AbortSignal) {
  const socket = createConnection({ host, port, noDelay: true });
  const connection = socketConnection(socket);
  try {
    await once(socket, "connect", { signal });
    signal.throwIfAborted();
    return connection;
  } catch (error) {
    await connection.close();
    throw error;
  }
}

async function listen(
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<TransportConnection> {
  const server = createServer({ noDelay: true });
  server.maxConnections = 1;
  let peer: TransportConnection | undefined;
  let fault: Error | undefined;
  let listenerClosed: Promise<void> | undefined;

  function stopAccepting() {
    listenerClosed ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    return listenerClosed;
  }
  async function close() {
    await Promise.all([stopAccepting(), peer?.close()]);
  }

  server.on("error", (error) => {
    fault = error;
  });
  server.on("connection", (socket) => {
    if (listenerClosed) {
      socket.destroy();
      return;
    }
    peer = socketConnection(socket);
    void stopAccepting();
  });

  try {
    const ready = once(server, "listening", { signal });
    server.listen({ host, port, backlog: 1, exclusive: true });
    await ready;
    signal.throwIfAborted();
  } catch (error) {
    await close();
    throw error;
  }

  return {
    async read({ maxBytes, waitMs, signal }) {
      signal.throwIfAborted();
      const deadline = performance.now() + waitMs;
      if (!peer && !listenerClosed && !fault)
        await waitForEvent(
          server,
          ["connection", "close", "error"],
          waitMs,
          signal,
        );
      signal.throwIfAborted();
      if (fault) throw fault;
      if (!peer) return listenerClosed ? null : new Uint8Array();
      const remaining = Math.max(0, Math.floor(deadline - performance.now()));
      return peer.read({ maxBytes, waitMs: remaining, signal });
    },
    write(options) {
      options.signal.throwIfAborted();
      if (fault) throw fault;
      return peer?.write(options) ?? 0;
    },
    close,
  };
}

export function registerTcpTransport(transportId: string): NodeRegister {
  return (context) => {
    const connections = new Set<Promise<TransportConnection>>();
    const lifetime = new AbortController();
    context.transports.register(transportId, async ({ params, signal }) => {
      const opening = AbortSignal.any([signal, lifetime.signal]);
      opening.throwIfAborted();
      const { host = defaultTcpHost, port, role = "client" } = params;
      if (
        Object.keys(params).some(
          (key) => !["host", "port", "role"].includes(key),
        ) ||
        typeof host !== "string" ||
        !tcpHostPattern.test(host) ||
        typeof port !== "number" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        (role !== "client" && role !== "server") ||
        (role === "server" && isIP(host) === 0)
      )
        throw new Error("Expected a TCP role, endpoint address and port");

      const pending =
        role === "server"
          ? listen(host, port, opening)
          : connect(host, port, opening);
      connections.add(pending);
      try {
        const connection = await pending;
        return {
          ...connection,
          async close() {
            await connection.close();
            connections.delete(pending);
          },
        };
      } catch (error) {
        connections.delete(pending);
        throw error;
      }
    });

    return async () => {
      lifetime.abort();
      await Promise.all(
        [...connections].map((pending) =>
          pending.then(
            (connection) => connection.close(),
            () => undefined,
          ),
        ),
      );
      connections.clear();
    };
  };
}

export { connect as connectTcp };
