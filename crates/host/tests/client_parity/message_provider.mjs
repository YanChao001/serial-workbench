import { createSocket } from "node:dgram";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";

export function register(context) {
  context.transports.register(
    "reference.transport.tcp",
    async ({ params, signal }) => {
      const socket = createSocket("udp4");
      const connected = once(socket, "connect", { signal });
      socket.connect(params.port, "127.0.0.1");
      try {
        await connected;
      } catch (error) {
        socket.close();
        throw error;
      }
      const queue = [];
      let stopped;
      let fault;
      socket.on("error", (error) => {
        fault = error;
      });
      socket.on("message", (bytes) => {
        if (queue.length >= 8) {
          fault = new Error("Fixture receive queue is full");
          return;
        }
        queue.push(bytes);
      });
      return {
        async readMessage({ waitMs, signal }) {
          signal.throwIfAborted();
          if (!queue.length) await setTimeout(waitMs, undefined, { signal });
          if (fault) throw fault;
          const bytes = queue.shift();
          if (bytes?.equals(Buffer.of(0xfa, 0xce))) return null;
          if (!bytes) return undefined;
          return {
            bytes,
            messageType:
              bytes.length === 0
                ? "datagram"
                : bytes[0] === 84
                  ? "text"
                  : "binary",
          };
        },
        async write({ bytes, signal }) {
          signal.throwIfAborted();
          if (Buffer.from(bytes).equals(Buffer.from("partial"))) return 1;
          return await new Promise((resolve, reject) =>
            socket.send(bytes, (error, count) =>
              error ? reject(error) : resolve(count),
            ),
          );
        },
        close() {
          stopped ??= new Promise((resolve) => socket.close(resolve));
          return stopped;
        },
      };
    },
  );
  return () => {};
}
