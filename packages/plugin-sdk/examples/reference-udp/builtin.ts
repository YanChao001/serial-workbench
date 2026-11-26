import { createSocket } from "node:dgram";
import { EventEmitter, once } from "node:events";
import { networkInterfaces } from "node:os";
import type {
  NodeRegister,
  TransportMessageConnection,
  TransportWriteOptions,
} from "@serial-workbench/plugin-sdk/node";
import { builtinUdpProviderId, udpEndpoint } from "./endpoint.ts";

type Endpoint = Exclude<ReturnType<typeof udpEndpoint>, { error: string }>;
const maxQueuedDatagrams = 256;
const maxQueuedBytes = 1024 * 1024;

function isDirectedBroadcast(localAddress: string, destination: string) {
  return Object.values(networkInterfaces()).some((entries) =>
    entries?.some((entry) => {
      if (entry.family !== "IPv4" || entry.address !== localAddress)
        return false;
      const prefix = Number(entry.cidr?.split("/")[1]);
      if (!entry.cidr || prefix < 1 || prefix > 30) return false;
      const mask = entry.netmask.split(".").map(Number);
      const broadcast = localAddress
        .split(".")
        .map((part, i) => Number(part) | (255 ^ (mask[i] ?? 255)));
      return broadcast.join(".") === destination;
    }),
  );
}

async function openUdp(
  endpoint: Endpoint,
  signal: AbortSignal,
): Promise<TransportMessageConnection> {
  signal.throwIfAborted();
  const { family, mode, host, port, localAddress, localPort } = endpoint;
  if (
    mode === "broadcast" &&
    host !== "255.255.255.255" &&
    !isDirectedBroadcast(localAddress, host)
  )
    throw new Error(
      "Expected an IPv4 broadcast address for the selected interface",
    );

  const socket =
    family === "ipv6"
      ? createSocket({ type: "udp6", ipv6Only: true })
      : createSocket("udp4");
  const maxPayload = family === "ipv4" ? 65_507 : 65_527;
  const incoming: Buffer[] = [];
  const received = new EventEmitter();
  let queuedBytes = 0;
  let fault: Error | undefined;
  let closing = false;
  let closed = false;
  const stopped = new Promise<void>((resolve) => {
    socket.once("close", () => {
      closed = true;
      received.emit("ready");
      resolve();
    });
  });

  function close() {
    if (!closing) {
      closing = true;
      socket.close();
    }
    return stopped;
  }

  function fail(error: Error) {
    if (closing) return;
    fault = error;
    received.emit("ready");
    void close();
  }

  socket.on("error", fail);
  socket.on("message", (packet) => {
    if (closing) return;
    if (
      incoming.length >= maxQueuedDatagrams ||
      queuedBytes + packet.length > maxQueuedBytes
    ) {
      fail(new Error("UDP receive queue limit reached"));
      return;
    }
    incoming.push(packet);
    queuedBytes += packet.length;
    received.emit("ready");
  });

  try {
    socket.bind(localPort, localAddress);
    await once(socket, "listening", { signal });
    signal.throwIfAborted();
    if (mode === "unicast") {
      socket.connect(port, host);
      await once(socket, "connect", { signal });
      signal.throwIfAborted();
    } else if (endpoint.mode === "multicast") {
      socket.addMembership(host, endpoint.multicastInterface);
      socket.setMulticastInterface(endpoint.multicastInterface);
      socket.setMulticastLoopback(true);
    } else {
      socket.setBroadcast(true);
    }
    if (fault) throw fault;
  } catch (error) {
    await close();
    throw error;
  }

  async function write({ bytes, waitMs, signal }: TransportWriteOptions) {
    signal.throwIfAborted();
    if (closing || bytes.byteLength > maxPayload) return 0;
    const destination =
      endpoint.mode === "multicast" ? endpoint.sendHost : host;
    try {
      return await new Promise<number>((resolve, reject) => {
        function complete(error: Error | null, count?: number) {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else if (count !== bytes.byteLength)
            reject(new Error("UDP send length is unknown"));
          else resolve(count);
        }
        function abort() {
          complete(new Error("UDP send cancelled", { cause: signal.reason }));
        }
        const timer = setTimeout(
          () => complete(new Error("UDP send timed out")),
          waitMs,
        );
        signal.addEventListener("abort", abort, { once: true });
        try {
          if (mode === "unicast") socket.send(bytes, complete);
          else socket.send(bytes, port, destination, complete);
        } catch (error) {
          complete(new Error("UDP send failed", { cause: error }));
        }
      });
    } catch (error) {
      await close();
      throw error;
    }
  }

  return {
    async readMessage({ maxBytes, waitMs, signal }) {
      signal.throwIfAborted();
      if (!incoming.length && !fault && !closed && waitMs > 0) {
        const timeout = AbortSignal.timeout(waitMs);
        try {
          await once(received, "ready", {
            signal: AbortSignal.any([signal, timeout]),
          });
        } catch (error) {
          if (!timeout.aborted) throw error;
        }
        signal.throwIfAborted();
      }
      const packet = incoming.shift();
      if (packet) {
        queuedBytes -= packet.length;
        if (packet.length > maxBytes)
          throw new Error("UDP datagram exceeds the receive budget");
        return { bytes: packet, messageType: "datagram" };
      }
      if (fault) throw fault;
      return closed ? null : undefined;
    },
    write,
    close,
  };
}

export const register: NodeRegister = (context) => {
  const connections = new Set<Promise<TransportMessageConnection>>();
  const lifetime = new AbortController();
  context.transports.register(
    builtinUdpProviderId,
    async ({ params, signal }) => {
      const endpoint = udpEndpoint(params);
      if ("error" in endpoint)
        throw new Error("Invalid UDP parameter: " + endpoint.error);
      const pending = openUdp(
        endpoint,
        AbortSignal.any([signal, lifetime.signal]),
      );
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
