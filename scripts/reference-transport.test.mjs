import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import test from "node:test";
import { register } from "../packages/plugin-sdk/examples/reference-transport/main.ts";

const host = "127.0.0.1";
const signal = new AbortController().signal;

async function reserve(port = 0) {
  const server = createServer();
  const listening = once(server, "listening");
  server.listen({ host, port });
  await listening;
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function harness(t) {
  const reserved = await reserve();
  await reserved.close();
  let open;
  const stop = register({
    transports: {
      register(action, handler) {
        assert.equal(action, "reference.transport.tcp");
        open = handler;
      },
    },
  });
  t.after(stop);
  return {
    stop,
    port: reserved.port,
    listen: (opening = signal) =>
      open({
        params: { role: "server", port: reserved.port },
        signal: opening,
      }),
  };
}

test(
  "a TCP listener preserves buffered bytes at FIN and refuses a second peer",
  { timeout: 5_000 },
  async (t) => {
    const { listen, port } = await harness(t);
    const transport = await listen();
    const read = (maxBytes) =>
      transport.read({ maxBytes, waitMs: 500, signal });
    assert.equal((await read(2)).byteLength, 0);
    const beforePeer = await transport.write({
      bytes: Buffer.from([0xee]),
      waitMs: 100,
      signal,
    });
    assert.equal(beforePeer, 0);

    const pending = read(2);
    const peer = createConnection({ host, port });
    t.after(() => peer.destroy());
    await once(peer, "connect");
    peer.end(Buffer.from([0, 255, 13, 10, 128]));
    const received = [];
    let part = await pending;
    while (part !== null) {
      assert.ok(part.length <= 2);
      received.push(...part);
      part = await read(2);
    }
    assert.deepEqual(received, [0, 255, 13, 10, 128]);
    const refused = createConnection({ host, port });
    t.after(() => refused.destroy());
    await assert.rejects(once(refused, "connect"), { code: "ECONNREFUSED" });

    await transport.close();
    const next = await listen();
    assert.equal(
      (await next.read({ maxBytes: 2, waitMs: 0, signal })).byteLength,
      0,
    );
    await next.close();
  },
);

test(
  "a busy listener and cancelled reads release their own resources",
  { timeout: 5_000 },
  async (t) => {
    const { listen, port, stop } = await harness(t);
    const occupant = await reserve(port);
    t.after(occupant.close);
    await assert.rejects(listen(), { code: "EADDRINUSE" });
    await occupant.close();

    const opening = new AbortController();
    const cancelledOpen = listen(opening.signal);
    const opened = assert.rejects(cancelledOpen, { name: "AbortError" });
    opening.abort();
    await opened;

    const transport = await listen();
    const reading = new AbortController();
    const pending = transport.read({
      maxBytes: 1,
      waitMs: 2_000,
      signal: reading.signal,
    });
    const aborted = assert.rejects(pending, { name: "AbortError" });
    reading.abort();
    await aborted;

    const waiting = transport.read({ maxBytes: 1, waitMs: 2_000, signal });
    await stop();
    assert.equal(await waiting, null);
    const rebound = await reserve(port);
    await rebound.close();
  },
);
