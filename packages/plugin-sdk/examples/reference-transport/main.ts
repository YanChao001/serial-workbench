import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import type {
  NodeRegister,
  TransportConnection,
} from "@serial-workbench/plugin-sdk/node";

const transportId = "reference.transport.tcp";

function waitForRead(socket: Socket, waitMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      clearTimeout(timeout);
      socket.off("readable", ready);
      socket.off("end", ready);
      socket.off("close", ready);
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
    socket.once("readable", ready);
    socket.once("end", ready);
    socket.once("close", ready);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export const register: NodeRegister = (context) => {
  const connections = new Set<() => Promise<void>>();
  context.transports.register(transportId, async ({ params, signal }) => {
    signal.throwIfAborted();
    const { port } = params;
    if (
      Object.keys(params).length !== 1 ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error("TCP loopback requires a valid port");

    const socket = createConnection({ host: "127.0.0.1", port, noDelay: true });
    let fault: Error | undefined;
    socket.on("error", (error) => {
      fault = error;
    });
    const opening = new AbortController();
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        opening.abort(fault ?? new Error("TCP connection closed during open"));
        connections.delete(close);
        resolve();
      });
    });
    function close() {
      socket.destroy();
      return closed;
    }
    connections.add(close);

    try {
      await once(socket, "connect", {
        signal: AbortSignal.any([signal, opening.signal]),
      });
      signal.throwIfAborted();
    } catch (error) {
      await close();
      throw error;
    }

    const connection: TransportConnection = {
      async read({ maxBytes, waitMs, signal }) {
        signal.throwIfAborted();
        if (
          !socket.readableLength &&
          !socket.readableEnded &&
          !socket.destroyed
        )
          await waitForRead(socket, waitMs, signal);
        signal.throwIfAborted();
        const available = Math.min(socket.readableLength, maxBytes);
        if (available > 0) {
          const bytes: unknown = socket.read(available);
          if (!Buffer.isBuffer(bytes)) throw new Error("Invalid TCP input");
          return bytes;
        }
        if (fault) throw fault;
        return socket.readableEnded || socket.destroyed
          ? null
          : new Uint8Array();
      },
      async write({ bytes, waitMs, signal }) {
        signal.throwIfAborted();
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
    return connection;
  });

  return async () => {
    await Promise.all([...connections].map((close) => close()));
  };
};
