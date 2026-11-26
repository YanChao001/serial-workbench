import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import type {
  NodeRegister,
  TransportMessageConnection,
} from "@serial-workbench/plugin-sdk/node";
import {
  waitForActivity,
  websocketConnection,
  websocketLimits,
} from "./connection.ts";
import { builtinWebsocketProviderId, websocketEndpoint } from "./endpoint.ts";

type Endpoint = Exclude<
  ReturnType<typeof websocketEndpoint>,
  { error: string }
>;
const openingTimeoutMs = 3000;

async function connect(
  endpoint: Extract<Endpoint, { role: "client" }>,
  signal: AbortSignal,
) {
  const socket = new WebSocket(endpoint.url, {
    ...websocketLimits,
    followRedirects: false,
    handshakeTimeout: openingTimeoutMs,
    rejectUnauthorized: true,
  });
  const connection = websocketConnection(socket, endpoint.sendType);
  try {
    await once(socket, "open", { signal });
    signal.throwIfAborted();
    return connection;
  } catch (error) {
    await connection.close();
    throw error;
  }
}

async function listen(
  endpoint: Extract<Endpoint, { role: "server" }>,
  signal: AbortSignal,
) {
  const server = createServer(
    {
      maxHeaderSize: 8 * 1024,
      requestTimeout: openingTimeoutMs,
      headersTimeout: openingTimeoutMs,
    },
    (_request, reply) => {
      reply.writeHead(426, { Connection: "close" });
      reply.end();
    },
  );
  server.maxConnections = 16;
  server.on("connect", (_request, socket) => socket.destroy());
  const framer = new WebSocketServer({
    ...websocketLimits,
    noServer: true,
    clientTracking: false,
  });
  const pendingSockets = new Set<Socket>();
  const activity = new EventEmitter();
  let peer: TransportMessageConnection | undefined;
  let fault: Error | undefined;
  let stopping: Promise<void> | undefined;

  server.on("connection", (socket) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    pendingSockets.add(socket);
    socket.once("close", () => pendingSockets.delete(socket));
    socket.setTimeout(openingTimeoutMs, () => socket.destroy());
  });
  server.on("error", (error) => {
    fault ??= error;
    activity.emit("ready");
  });
  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    let refusal: string | undefined;
    if (stopping || peer) refusal = "409 Conflict";
    else if (request.url?.split("?", 1)[0] !== endpoint.path)
      refusal = "404 Not Found";
    else if (
      (origin !== undefined && origin !== endpoint.browserOrigin) ||
      request.headers["sec-websocket-origin"] !== undefined
    )
      refusal = "403 Forbidden";
    if (refusal) {
      socket.once("error", () => socket.destroy());
      socket.end(
        "HTTP/1.1 " +
          refusal +
          "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    framer.handleUpgrade(request, socket, head, (ws) => {
      pendingSockets.delete(request.socket);
      request.socket.setTimeout(0);
      peer = websocketConnection(ws, endpoint.sendType);
      activity.emit("ready");
    });
  });

  function close() {
    if (!stopping) {
      const listenerClosed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      const framerClosed = new Promise<void>((resolve) =>
        framer.close(() => resolve()),
      );
      stopping = Promise.all([
        listenerClosed,
        framerClosed,
        peer?.close(),
      ]).then(() => {});
      for (const socket of pendingSockets) socket.destroy();
      activity.emit("ready");
    }
    return stopping;
  }

  try {
    const ready = once(server, "listening", { signal });
    server.listen({
      host: endpoint.bindAddress,
      port: endpoint.port,
      exclusive: true,
      backlog: 16,
    });
    await ready;
    signal.throwIfAborted();
  } catch (error) {
    await close();
    throw error;
  }

  const connection: TransportMessageConnection = {
    async readMessage(options) {
      options.signal.throwIfAborted();
      const deadline = performance.now() + options.waitMs;
      if (!peer && !stopping && !fault)
        await waitForActivity(activity, options.waitMs, options.signal);
      if (fault) throw fault;
      if (peer)
        return peer.readMessage({
          ...options,
          waitMs: Math.max(0, Math.floor(deadline - performance.now())),
        });
      return stopping ? null : undefined;
    },
    write(options) {
      options.signal.throwIfAborted();
      return peer?.write(options) ?? 0;
    },
    close,
  };
  return connection;
}

export const register: NodeRegister = (context) => {
  const connections = new Set<Promise<TransportMessageConnection>>();
  const lifetime = new AbortController();
  context.transports.register(
    builtinWebsocketProviderId,
    async ({ params, signal }) => {
      const endpoint = websocketEndpoint(params);
      if ("error" in endpoint)
        throw new Error("Invalid WebSocket parameter: " + endpoint.error);
      const opening = AbortSignal.any([signal, lifetime.signal]);
      opening.throwIfAborted();
      const pending =
        endpoint.role === "client"
          ? connect(endpoint, opening)
          : listen(endpoint, opening);
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
    },
  );
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
