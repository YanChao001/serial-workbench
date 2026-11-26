import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";
import descriptor from "../crates/host/resources/node-packages/udp.json" with { type: "json" };
import { register } from "../packages/plugin-sdk/examples/reference-udp/builtin.ts";

const signal = new AbortController().signal;
const waitMs = 1_000;

function harness(t) {
  let open;
  const stop = register({
    transports: {
      register(id, handler) {
        assert.equal(id, "swb.builtin.udp.transport");
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

async function bind(socket, port, host) {
  const listening = once(socket, "listening");
  socket.bind(port, host);
  await listening;
  return socket.address().port;
}

function close(socket) {
  return new Promise((resolve) => socket.close(resolve));
}

function send(socket, bytes, port, host) {
  return new Promise((resolve, reject) => {
    socket.send(bytes, port, host, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function receive(socket) {
  return once(socket, "message", { signal: AbortSignal.timeout(waitMs) });
}

const read = (transport, options = {}) =>
  transport.readMessage({ maxBytes: 128 * 1024, waitMs, signal, ...options });

test("the bundled UDP archive matches the signed descriptor and SDK source", () => {
  const root = new URL("../", import.meta.url);
  const folder = "packages/plugin-sdk/examples/reference-udp/";
  const read = (file) => readFileSync(new URL(file, root));
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const manifestBytes = read(folder + "builtin-manifest.json");
  const manifest = JSON.parse(manifestBytes);
  assert.ok(validateNodePackageManifest(manifest));
  assert.equal(manifest.id, "swb.builtin.udp");
  assert.equal(manifest.id, descriptor.id);
  assert.equal(manifest.version, descriptor.version);
  assert.equal(
    manifest.contributes.transports[0].actionId,
    "swb.builtin.udp.transport",
  );
  assert.equal(descriptor.sourceApproval.source, "swb.product");
  assert.equal(descriptor.manifestSha256, digest(manifestBytes));
  assert.equal(
    descriptor.archiveSha256,
    digest(read("crates/host/resources/node-packages/udp.zip")),
  );
  const { outputFiles } = buildSync({
    absWorkingDir: fileURLToPath(root),
    entryPoints: [folder + "builtin.ts"],
    bundle: true,
    platform: "node",
    target: "node26",
    format: "esm",
    write: false,
  });
  assert.equal(
    descriptor.compiledModuleSha256,
    digest(outputFiles[0].contents),
  );
});

for (const [family, type, host] of [
  ["ipv4", "udp4", "127.0.0.1"],
  ["ipv6", "udp6", "::1"],
]) {
  test(
    `${family} UDP unicast carries whole datagrams and filters other peers`,
    { timeout: 5_000 },
    async (t) => {
      const peer = createSocket(type);
      const other = createSocket(type);
      t.after(() => close(peer));
      t.after(() => close(other));
      const port = await bind(peer, 0, host);
      await bind(other, 0, host);
      const { open } = harness(t);
      const transport = await open({
        family,
        mode: "unicast",
        host,
        port,
        localAddress: host,
      });
      assert.equal(await read(transport, { waitMs: 0 }), undefined);

      const outgoing = Buffer.from([0, 255, 13, 10]);
      const observed = receive(peer);
      assert.equal(
        await transport.write({ bytes: outgoing, waitMs, signal }),
        outgoing.length,
      );
      const [bytes, source] = await observed;
      assert.deepEqual(bytes, outgoing);
      assert.equal(source.address, host);

      await send(other, Uint8Array.of(0xee), source.port, host);
      const incoming = Buffer.alloc(20_001, 0xab);
      await send(peer, incoming, source.port, host);
      assert.deepEqual(await read(transport), {
        bytes: incoming,
        messageType: "datagram",
      });
      await send(peer, Buffer.alloc(0), source.port, host);
      assert.deepEqual(await read(transport), {
        bytes: Buffer.alloc(0),
        messageType: "datagram",
      });
      assert.equal(await read(transport, { waitMs: 20 }), undefined);

      assert.equal(
        await transport.write({ bytes: Buffer.alloc(65_536), waitMs, signal }),
        0,
      );
      await Promise.all([transport.close(), transport.close()]);
      assert.equal(await read(transport), null);
      const rebound = createSocket(type);
      await bind(rebound, source.port, host);
      await close(rebound);
    },
  );
}

test(
  "UDP validates incompatibilities before opening and frees a cancelled bind",
  { timeout: 5_000 },
  async (t) => {
    const { open, stop } = harness(t);
    const base = {
      family: "ipv4",
      host: "127.0.0.1",
      port: 10000,
      mode: "unicast",
    };
    await assert.rejects(
      open({ ...base, host: "224.0.0.114" }),
      /Invalid UDP parameter: host/,
    );
    await assert.rejects(
      open({ ...base, family: "ipv6", host: "::1", mode: "broadcast" }),
      /Invalid UDP parameter: mode/,
    );
    await assert.rejects(
      open({ ...base, family: "ipv6", host: "fe80::1%0" }),
      /Invalid UDP parameter: host/,
    );
    await assert.rejects(
      open({ ...base, family: "ipv6", host: "ff02::114", mode: "multicast" }),
      /Invalid UDP parameter: multicastInterface/,
    );
    await assert.rejects(
      open({
        ...base,
        host: "239.255.15.42",
        localAddress: "127.0.0.1",
        multicastInterface: "127.0.0.1",
        mode: "multicast",
      }),
      /Invalid UDP parameter: localAddress/,
    );
    await assert.rejects(
      open({
        ...base,
        family: "ipv6",
        host: "ff02::114",
        multicastInterface: "1\n",
        mode: "multicast",
      }),
      /Invalid UDP parameter: multicastInterface/,
    );
    await assert.rejects(
      open({
        ...base,
        host: "127.0.0.2",
        localAddress: "127.0.0.1",
        mode: "broadcast",
      }),
      /Expected an IPv4 broadcast address/,
    );

    const socket = createSocket("udp4");
    const localPort = await bind(socket, 0, "127.0.0.1");
    const endpoint = { ...base, localAddress: "127.0.0.1", localPort };
    try {
      await assert.rejects(open(endpoint), { code: "EADDRINUSE" });
    } finally {
      await close(socket);
    }
    const controller = new AbortController();
    const pending = open(endpoint, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });

    const transport = await open(endpoint);
    const reader = new AbortController();
    const blocked = read(transport, { signal: reader.signal });
    reader.abort();
    await assert.rejects(blocked, { name: "AbortError" });
    await stop();
    assert.equal(await read(transport), null);
    const next = createSocket("udp4");
    await bind(next, localPort, "127.0.0.1");
    await close(next);
  },
);

const ipv6MulticastIndex =
  process.env.SWB_UDP_IPV6_MULTICAST_INDEX ??
  (process.platform === "win32" ? "1" : undefined);

test(
  "UDP joins and sends IPv6 multicast on the explicit isolated interface",
  {
    timeout: 5_000,
    skip:
      !ipv6MulticastIndex &&
      "Configure a multicast-capable isolated IPv6 interface",
  },
  async (t) => {
    const group = "ff02::114";
    const iface = "::%" + ipv6MulticastIndex;
    const peer = createSocket({ type: "udp6", ipv6Only: true });
    t.after(() => close(peer));
    const port = await bind(peer, 0, "::");
    peer.addMembership(group, iface);
    peer.setMulticastInterface(iface);
    const reservation = createSocket({ type: "udp6", ipv6Only: true });
    const localPort = await bind(reservation, 0, "::");
    await close(reservation);

    const { open } = harness(t);
    const transport = await open({
      family: "ipv6",
      mode: "multicast",
      host: group,
      port,
      localPort,
      multicastInterface: ipv6MulticastIndex,
    });
    const bytes = Buffer.from([0x81, 0]);
    const pending = receive(peer);
    assert.equal(
      await transport.write({ bytes, waitMs, signal }),
      bytes.length,
    );
    assert.deepEqual((await pending)[0], bytes);
    const reply = Buffer.from([0x61, 0, 0xff]);
    await send(peer, reply, localPort, group + "%" + ipv6MulticastIndex);
    assert.deepEqual(await read(transport), {
      bytes: reply,
      messageType: "datagram",
    });
  },
);

test(
  "UDP sends to an IPv4 directed broadcast with a distinct loopback peer",
  { timeout: 5_000 },
  async (t) => {
    const peer = createSocket("udp4");
    t.after(() => close(peer));
    const port = await bind(peer, 0, "0.0.0.0");
    const { open } = harness(t);
    const transport = await open({
      mode: "broadcast",
      host: "127.255.255.255",
      port,
      localAddress: "127.0.0.1",
    });
    const pending = receive(peer);
    const bytes = Buffer.from([0xb0, 0x00, 0xff]);
    assert.equal(
      await transport.write({ bytes, waitMs, signal }),
      bytes.length,
    );
    const [observed, source] = await pending;
    assert.deepEqual(observed, bytes);
    assert.equal(source.address, "127.0.0.1");
    const reply = Buffer.from([0, 0x5a]);
    await send(peer, reply, source.port, source.address);
    assert.deepEqual(await read(transport), {
      bytes: reply,
      messageType: "datagram",
    });
  },
);

test(
  "UDP joins and sends IPv4 multicast on the explicit loopback interface",
  { timeout: 5_000 },
  async (t) => {
    const group = "239.255.15.42";
    const iface = "127.0.0.1";
    const peer = createSocket("udp4");
    t.after(() => close(peer));
    const port = await bind(peer, 0, "0.0.0.0");
    peer.addMembership(group, iface);
    peer.setMulticastInterface(iface);
    const reservation = createSocket("udp4");
    const localPort = await bind(reservation, 0, "0.0.0.0");
    await close(reservation);
    const { open } = harness(t);
    const transport = await open({
      mode: "multicast",
      host: group,
      port,
      localPort,
      multicastInterface: iface,
    });
    const bytes = Buffer.from([0x19, 0x88, 0]);
    const pending = receive(peer);
    assert.equal(
      await transport.write({ bytes, waitMs, signal }),
      bytes.length,
    );
    assert.deepEqual((await pending)[0], bytes);
    const reply = Buffer.from([0xff, 0]);
    await send(peer, reply, localPort, group);
    assert.deepEqual(await read(transport), {
      bytes: reply,
      messageType: "datagram",
    });
  },
);
