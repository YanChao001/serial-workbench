import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { createPluginTransportLane } from "../crates/host/src/node_backend/transport.mjs";

const credential = "a".repeat(43);

async function fixture(t, connection) {
  const listener = createServer();
  const listening = once(listener, "listening");
  listener.listen(0, "127.0.0.1");
  await listening;
  const connecting = once(listener, "connection");
  const lane = createPluginTransportLane({
    address: "127.0.0.1:" + listener.address().port,
    credential,
    params: {},
    open: async () => connection,
  });
  const [peer] = await connecting;
  const stream = peer.iterator({ destroyOnReturn: false });
  let received = Buffer.alloc(0);
  t.after(async () => {
    peer.destroy();
    await lane.finished;
    await new Promise((resolve) => listener.close(resolve));
  });
  async function fill(minimum) {
    while (received.length < minimum) {
      const chunk = await stream.next();
      assert.equal(chunk.done, false, "Private wire ended before reply");
      received = Buffer.concat([received, chunk.value]);
    }
  }
  const read = async () => {
    await fill(4);
    const length = received.readUInt32BE();
    await fill(length + 4);
    const response = JSON.parse(
      received.subarray(4, length + 4).toString("utf8"),
    );
    received = received.subarray(length + 4);
    return response;
  };
  const send = (frame) => {
    const bytes = Buffer.from(JSON.stringify(frame));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);
    peer.write(Buffer.concat([header, bytes]));
  };
  assert.deepEqual(await read(), { kind: "hello", credential });
  send({ kind: "start" });
  return {
    read,
    send,
    async close() {
      send({ kind: "close" });
      assert.deepEqual(await read(), { kind: "closed" });
      peer.end();
      await lane.finished;
    },
  };
}

test(
  "message lane distinguishes idle, empty message, binary data and EOF",
  { timeout: 5000 },
  async (t) => {
    const values = [
      undefined,
      { bytes: Uint8Array.of(), messageType: "datagram" },
      { bytes: Uint8Array.of(0, 255, 128), messageType: "binary" },
      null,
    ];
    const lane = await fixture(t, {
      readMessage({ maxBytes }) {
        assert.equal(maxBytes, 131072);
        return values.shift();
      },
      write: ({ bytes }) => bytes.length,
      close() {},
    });
    assert.deepEqual(await lane.read(), {
      kind: "opened",
      semantics: "message",
    });
    const replies = [
      { kind: "read", bytes: "", eof: false },
      { kind: "message", bytes: "", messageType: "datagram" },
      { kind: "message", bytes: "AP+A", messageType: "binary" },
      { kind: "read", bytes: "", eof: true },
    ];
    for (const [index, reply] of replies.entries()) {
      const id = index + 1;
      lane.send({ kind: "read", id, maxBytes: 131072, waitMs: 0 });
      assert.deepEqual(await lane.read(), { ...reply, id });
    }
    await lane.close();
  },
);

test(
  "message lane rejects an oversized message, unknown type and partial write",
  { timeout: 5000 },
  async (t) => {
    const values = [
      { bytes: new Uint8Array(131073), messageType: "binary" },
      { bytes: Uint8Array.of(7), messageType: "unknown" },
    ];
    const lane = await fixture(t, {
      readMessage: () => values.shift(),
      write: () => 1,
      close() {},
    });
    assert.deepEqual(await lane.read(), {
      kind: "opened",
      semantics: "message",
    });
    for (const id of [1, 2]) {
      lane.send({ kind: "read", id, maxBytes: 131072, waitMs: 0 });
      assert.deepEqual(await lane.read(), { kind: "error", id });
    }
    lane.send({ kind: "write", id: 3, bytes: "AAE=", waitMs: 0 });
    assert.deepEqual(await lane.read(), { kind: "error", id: 3 });
    await lane.close();
  },
);

test(
  "legacy streams keep their wire shape and prefix write semantics",
  { timeout: 5000 },
  async (t) => {
    const lane = await fixture(t, {
      read({ maxBytes }) {
        assert.equal(maxBytes, 16384);
        return Uint8Array.of(1, 2);
      },
      write: () => 1,
      close() {},
    });
    assert.deepEqual(await lane.read(), { kind: "opened" });
    lane.send({ kind: "read", id: 1, maxBytes: 16384, waitMs: 0 });
    assert.deepEqual(await lane.read(), {
      kind: "read",
      bytes: "AQI=",
      eof: false,
      id: 1,
    });
    lane.send({ kind: "write", id: 2, bytes: "AAE=", waitMs: 0 });
    assert.deepEqual(await lane.read(), {
      kind: "written",
      id: 2,
      accepted: 1,
    });
    await lane.close();
  },
);
