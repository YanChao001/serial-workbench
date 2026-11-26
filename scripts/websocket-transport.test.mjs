import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";
import descriptor from "../crates/host/resources/node-packages/websocket.json" with { type: "json" };
import { register } from "../packages/plugin-sdk/examples/reference-websocket/builtin.ts";
import { websocketMessageLimit } from "../packages/plugin-sdk/examples/reference-websocket/endpoint.ts";
import { buildDeviceWebsocket } from "./build-device-websocket.mjs";

const host = "127.0.0.1";
const signal = new AbortController().signal;
const waitMs = 1_000;

test("the signed device WebSocket archive matches its pinned source, dependency and license", async () => {
  const root = new URL("../", import.meta.url);
  const read = (path) => readFileSync(new URL(path, root));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const manifestBytes = read(
    "packages/plugin-sdk/examples/reference-websocket/builtin-manifest.json",
  );
  const manifest = JSON.parse(manifestBytes);
  assert.ok(validateNodePackageManifest(manifest));
  assert.equal(descriptor.id, manifest.id);
  assert.equal(descriptor.version, manifest.version);
  assert.equal(descriptor.sourceApproval.source, "swb.product");
  assert.equal(
    descriptor.archiveSha256,
    sha256(read("crates/host/resources/node-packages/websocket.zip")),
  );
  assert.equal(descriptor.manifestSha256, sha256(manifestBytes));
  assert.equal(
    JSON.parse(read("node_modules/ws/package.json")).version,
    "8.23.0",
  );
  assert.ok(manifest.notices.includes("third-party/ws.LICENSE"));
  assert.deepEqual(
    read("resources/third-party/ws.LICENSE"),
    read("node_modules/ws/LICENSE"),
  );
  const compiled = await buildDeviceWebsocket(false);
  assert.equal(
    descriptor.compiledModuleSha256,
    sha256(compiled.outputFiles[0].contents),
  );
});

function harness(t) {
  let open;
  const stop = register({
    transports: {
      register(id, handler) {
        assert.equal(id, "swb.builtin.websocket.transport");
        open = handler;
      },
    },
  });
  t.after(stop);
  return {
    open: (params, opening = signal) => open({ params, signal: opening }),
    stop,
  };
}

async function independentServer(t, address = host) {
  const server = new WebSocketServer({ host: address, port: 0 });
  await once(server, "listening");
  t.after(() => {
    for (const peer of server.clients) peer.terminate();
    return new Promise((resolve) => server.close(resolve));
  });
  const urlHost = address.includes(":") ? "[" + address + "]" : address;
  return { server, url: "ws://" + urlHost + ":" + server.address().port };
}

function deadlineEvent(target, event) {
  return once(target, event, { signal: AbortSignal.timeout(waitMs) });
}

function read(connection, options = {}) {
  return connection.readMessage({
    maxBytes: websocketMessageLimit,
    waitMs,
    signal,
    ...options,
  });
}

function send(connection, bytes) {
  return connection.write({ bytes, waitMs, signal });
}

async function openPeer(url, options) {
  const socket = new WebSocket(url, options);
  socket.on("error", () => {});
  await deadlineEvent(socket, "open");
  return socket;
}

async function reservePort() {
  const probe = createServer();
  probe.listen(0, host);
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test(
  "the client preserves split binary, UTF-8, empty messages and the prefix at normal close",
  { timeout: 5_000 },
  async (t) => {
    const { server, url } = await independentServer(t, "::1");
    const { open } = harness(t);
    const receivedPeer = deadlineEvent(server, "connection");
    const connection = await open({ url: url + "/device?channel=1" });
    const [peer, request] = await receivedPeer;
    assert.equal(request.url, "/device?channel=1");
    assert.equal(await read(connection, { waitMs: 0 }), undefined);
    const wire = deadlineEvent(peer, "message");
    const outgoing = Buffer.of(0, 255, 13, 10);
    assert.equal(await send(connection, outgoing), outgoing.length);
    assert.deepEqual(await wire, [outgoing, true]);
    assert.equal(
      await send(connection, Buffer.alloc(websocketMessageLimit + 1)),
      0,
    );

    const text = Buffer.from("T\u6d4b\u8bd5");
    const binary = Buffer.alloc(20_001, 0xa7);
    peer.send(text, { binary: false });
    peer.send("", { binary: false });
    peer.send(binary.subarray(0, 10_000), { binary: true, fin: false });
    peer.send(binary.subarray(10_000), { binary: true, fin: true });
    peer.close(1000);
    assert.deepEqual(await read(connection), {
      bytes: text,
      messageType: "text",
    });
    assert.deepEqual(await read(connection), {
      bytes: Buffer.alloc(0),
      messageType: "text",
    });
    assert.deepEqual(await read(connection), {
      bytes: binary,
      messageType: "binary",
    });
    assert.equal(await read(connection), null);
    await connection.close();
  },
);

test(
  "the listener checks path and browser origin, selects text writes and closes its one peer",
  { timeout: 5_000 },
  async (t) => {
    const port = await reservePort();
    const { open, stop } = harness(t);
    const origin = "http://127.0.0.1:5173";
    const connection = await open({
      role: "server",
      port,
      path: "/device",
      browserOrigin: origin,
      sendType: "text",
    });
    assert.equal(await send(connection, Buffer.of(0x41)), 0);
    const url = "ws://" + host + ":" + port;
    await assert.rejects(openPeer(url + "/other", { origin }), /404/);
    await assert.rejects(
      openPeer(url + "/device", { origin: "http://127.0.0.1:5174" }),
      /403/,
    );
    const peer = await openPeer(url + "/device", { origin });
    t.after(() => peer.terminate());
    await assert.rejects(openPeer(url + "/device", { origin }), /409/);
    assert.equal(await send(connection, Buffer.of(0xff)), 0);
    const text = Buffer.from("probe");
    const receipt = deadlineEvent(peer, "message");
    assert.equal(await send(connection, text), text.length);
    assert.deepEqual(await receipt, [text, false]);
    peer.send(Buffer.alloc(0));
    assert.deepEqual(await read(connection), {
      bytes: Buffer.alloc(0),
      messageType: "binary",
    });
    const closed = deadlineEvent(peer, "close");
    await stop();
    assert.equal((await closed)[0], 1000);
    const rebound = createServer();
    rebound.listen(port, host);
    await deadlineEvent(rebound, "listening");
    await new Promise((resolve) => rebound.close(resolve));
  },
);

test(
  "a fragmented message over budget fails with close code 1009 after the accepted prefix",
  { timeout: 5_000 },
  async (t) => {
    const { server, url } = await independentServer(t);
    const { open } = harness(t);
    const receivedPeer = deadlineEvent(server, "connection");
    const connection = await open({ url });
    const [peer] = await receivedPeer;
    const closed = deadlineEvent(peer, "close");
    peer.send("prefix");
    peer.send(Buffer.alloc(websocketMessageLimit), { fin: false });
    peer.send(Buffer.of(1), { fin: true });
    assert.deepEqual(await read(connection), {
      bytes: Buffer.from("prefix"),
      messageType: "text",
    });
    await assert.rejects(read(connection), /payload size/i);
    assert.equal((await closed)[0], 1009);
    await connection.close();
  },
);

test(
  "cancellation releases a pending handshake and listener shutdown releases an idle HTTP socket",
  { timeout: 5_000 },
  async (t) => {
    const stalled = createHttpServer();
    stalled.on("upgrade", () => {});
    stalled.listen(0, host);
    await once(stalled, "listening");
    let pendingSocket;
    stalled.on("connection", (socket) => {
      pendingSocket = socket;
    });
    t.after(() => {
      pendingSocket?.destroy();
      return new Promise((resolve) => stalled.close(resolve));
    });
    const { open } = harness(t);
    const abort = new AbortController();
    const upgrade = deadlineEvent(stalled, "upgrade");
    const starting = open(
      { url: "ws://" + host + ":" + stalled.address().port },
      abort.signal,
    );
    const [, socket] = await upgrade;
    socket.resume();
    const released = deadlineEvent(socket, "end");
    abort.abort();
    await assert.rejects(starting, { name: "AbortError" });
    await released;
    socket.destroy();

    const port = await reservePort();
    const listener = await open({ role: "server", port });
    const idle = createConnection({ host, port });
    await deadlineEvent(idle, "connect");
    const closed = deadlineEvent(idle, "close");
    await listener.close();
    await closed;
    assert.equal(await read(listener), null);
  },
);

test(
  "the client rejects non-WebSocket addresses and reports an abnormal peer disconnect",
  { timeout: 5_000 },
  async (t) => {
    const { open } = harness(t);
    for (const url of [
      "http://device.test/",
      "ws:device.test",
      "ws://user:pass@device.test",
      "ws://device.test/#ref",
    ]) {
      await assert.rejects(open({ url }), /Invalid WebSocket parameter: url/);
    }
    await assert.rejects(
      open({ role: "server", bindAddress: "localhost", port: 1234 }),
      /Invalid WebSocket parameter: bindAddress/,
    );
    const { server, url } = await independentServer(t);
    const receivedPeer = deadlineEvent(server, "connection");
    const connection = await open({ url });
    const [peer] = await receivedPeer;
    peer.terminate();
    await assert.rejects(read(connection), /closed abnormally/);
    await connection.close();
  },
);
