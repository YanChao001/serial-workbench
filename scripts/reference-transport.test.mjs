import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";
import descriptor from "../crates/host/resources/node-packages/tcp.json" with { type: "json" };
import reference from "../packages/plugin-sdk/examples/reference-transport/manifest.json" with { type: "json" };
import {
  builtinTcpPackageId,
  builtinTcpProviderId,
} from "../packages/plugin-sdk/examples/reference-transport/tcp-endpoint.ts";
import { register } from "../packages/plugin-sdk/examples/reference-transport/main.ts";

const host = "127.0.0.1";
const signal = new AbortController().signal;

async function reserve(port = 0, address = host) {
  const server = createServer();
  const listening = once(server, "listening");
  server.listen({ host: address, port });
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

test(
  "TCP device client and listener exchange binary bytes over IPv6",
  { timeout: 5000 },
  async (t) => {
    const address = "::1";
    const reserved = await reserve(0, address);
    await reserved.close();
    let open;
    const stop = register({
      transports: {
        register(_id, handler) {
          open = handler;
        },
      },
    });
    t.after(stop);
    const endpoint = { host: address, port: reserved.port };
    const server = await open({
      params: { role: "server", ...endpoint },
      signal,
    });
    const client = await open({
      params: { role: "client", ...endpoint },
      signal,
    });
    const data = Buffer.from([0, 255, 13, 10, 128]);
    for (const [from, to] of [
      [client, server],
      [server, client],
    ]) {
      assert.equal(
        await from.write({ bytes: data, waitMs: 500, signal }),
        data.length,
      );
      const result = [];
      while (result.length < data.length) {
        const chunk = await to.read({
          maxBytes: data.length - result.length,
          waitMs: 500,
          signal,
        });
        assert.ok(chunk?.length, "Expected IPv6 receive bytes");
        result.push(...chunk);
      }
      assert.deepEqual(Buffer.from(result), data);
    }
    await client.close();
    assert.equal(await server.read({ maxBytes: 1, waitMs: 500, signal }), null);
    await server.close();
    const rebound = await reserve(endpoint.port, address);
    await rebound.close();
  },
);

test("the bundled TCP transport matches its signed archive and the reference contract", () => {
  const root = new URL("../", import.meta.url);
  const folder = "packages/plugin-sdk/examples/reference-transport/";
  const manifestBytes = readFileSync(
    new URL(folder + "builtin-manifest.json", root),
  );
  const manifest = JSON.parse(manifestBytes);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.ok(validateNodePackageManifest(manifest));
  assert.equal(manifest.id, builtinTcpPackageId);
  assert.equal(descriptor.id, builtinTcpPackageId);
  assert.equal(manifest.version, descriptor.version);
  assert.equal(descriptor.sourceApproval.source, "swb.product");
  assert.equal(descriptor.manifestSha256, digest(manifestBytes));
  assert.equal(
    descriptor.archiveSha256,
    digest(
      readFileSync(
        new URL("crates/host/resources/node-packages/tcp.zip", root),
      ),
    ),
  );
  assert.deepEqual(manifest.permissions, reference.permissions);
  assert.deepEqual(manifest.contributes.transports, [
    { ...reference.contributes.transports[0], actionId: builtinTcpProviderId },
  ]);
  const { outputFiles } = buildSync({
    absWorkingDir: fileURLToPath(root),
    entryPoints: [folder + "builtin.ts"],
    bundle: true,
    platform: "node",
    target: "node26",
    format: "esm",
    charset: "utf8",
    legalComments: "none",
    write: false,
  });
  assert.equal(outputFiles.length, 1);
  assert.equal(
    descriptor.compiledModuleSha256,
    digest(outputFiles[0].contents),
  );
});
