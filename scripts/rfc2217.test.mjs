import { buildSync } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import descriptor from "../crates/host/resources/node-packages/rfc2217.json" with { type: "json" };
import {
  builtinRfc2217PackageId,
  builtinRfc2217ProviderId,
} from "../packages/plugin-sdk/examples/reference-rfc2217/builtin-endpoint.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import {
  openRfc2217,
  register,
  rfc2217TransportId,
} from "../packages/plugin-sdk/examples/reference-rfc2217/main.ts";
import { TelnetDecoder } from "../packages/plugin-sdk/examples/reference-rfc2217/telnet.ts";
import manifest from "../packages/plugin-sdk/examples/reference-rfc2217/manifest.json" with { type: "json" };
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";

const openingOptions = [255, 251, 0, 255, 253, 0, 255, 251, 44];
const acceptedOptions = [255, 253, 0, 255, 251, 0, 255, 253, 44];
const signal = new AbortController().signal;
const sub = (values) => Buffer.from([255, 250, 44, ...values, 255, 240]);

async function fixture(
  t,
  settings = {},
  controller = signal,
  open = openRfc2217,
) {
  const server = createServer();
  const listening = once(server, "listening");
  server.listen({ host: "127.0.0.1", port: 0 });
  await listening;
  const connecting = once(server, "connection");
  const pending = open({
    params: { port: server.address().port, baudRate: 115200, ...settings },
    signal: controller,
  });
  void pending.catch(() => {});
  const [peer] = await connecting;
  t.after(async () => {
    peer.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { peer, pending };
}

async function readWire(socket, length, wait = 1500) {
  const signal = AbortSignal.timeout(wait);
  let bytes = socket.read(length);
  while (bytes === null) {
    await once(socket, "readable", { signal });
    bytes = socket.read(length);
  }
  assert.equal(bytes.length, length);
  return bytes;
}

async function writeWire(socket, chunk) {
  await new Promise((resolve, reject) =>
    socket.write(chunk, (error) => (error ? reject(error) : resolve())),
  );
}

async function assertPeerClosed(peer, trigger) {
  const close = once(peer, "end", { signal: AbortSignal.timeout(1500) });
  peer.resume();
  await trigger();
  await close;
}

test("Telnet decoding separates a command and escapes at every octet boundary", () => {
  const parser = new TelnetDecoder();
  const wire = Buffer.of(
    0,
    255,
    255,
    13,
    255,
    253,
    44,
    128,
    255,
    250,
    44,
    106,
    255,
    255,
    255,
    240,
    10,
  );
  const items = Array.from(wire).flatMap((byte) =>
    parser.push(Uint8Array.of(byte)),
  );
  parser.finish();
  const data = items.filter((item) => item.kind === "data");
  assert.deepEqual(
    data.flatMap((item) => Array.from(item.bytes)),
    [0, 255, 13, 128, 10],
  );
  assert.deepEqual(
    items.filter((item) => item.kind !== "data"),
    [
      { kind: "option", verb: 253, option: 44 },
      { kind: "sub", option: 44, bytes: Uint8Array.of(106, 255) },
    ],
  );
  const incomplete = new TelnetDecoder();
  incomplete.push(Uint8Array.of(255, 250, 44, 106, 255));
  assert.throws(() => incomplete.finish(), /Truncated Telnet command/);
  const overrun = new TelnetDecoder();
  assert.throws(
    () => overrun.push(Buffer.from([255, 250, 44, ...new Array(256).fill(40)])),
    /exceeds 256 bytes/,
  );
});

test(
  "a registered RFC 2217 connection verifies remote settings and carries binary bytes",
  { timeout: 8000 },
  async (t) => {
    assert.ok(validateNodePackageManifest(manifest));
    assert.ok(rfc2217TransportId.startsWith(manifest.id + "."));
    assert.equal(
      manifest.contributes.transports[0].actionId,
      rfc2217TransportId,
    );
    let open;
    const stop = register({
      transports: {
        register(id, handler) {
          assert.equal(id, rfc2217TransportId);
          open = handler;
        },
      },
    });

    const { peer, pending } = await fixture(
      t,
      {
        baudRate: 65535,
        dataBits: 7,
        parity: "even",
        stopBits: "2",
        flowControl: "software",
        dtr: true,
        rts: false,
      },
      signal,
      open,
    );
    t.after(stop);
    assert.deepEqual(
      await readWire(peer, openingOptions.length),
      Buffer.from(openingOptions),
    );
    await writeWire(peer, Buffer.from([0x4e, 0x56, 0x54, ...acceptedOptions]));
    const settings = [
      [1, 0, 0, 255, 255, 255, 255],
      [2, 7],
      [3, 3],
      [4, 2],
      [5, 2],
      [5, 8],
      [5, 12],
    ];
    for (const [code, ...value] of settings) {
      const request = sub([code, ...value]);
      assert.deepEqual(await readWire(peer, request.length), request);
      if (code === 1) {
        await writeWire(
          peer,
          Buffer.concat([sub([code + 100, ...value]), sub([108])]),
        );
        await assert.rejects(readWire(peer, 7, 40), { name: "AbortError" });
        await writeWire(peer, sub([109]));
        continue;
      }
      await writeWire(
        peer,
        code === 5 && value[0] === 12
          ? Buffer.concat([
              sub([code + 100, ...value]),
              sub([107, 255, 255]),
              Buffer.from([0, 255, 255, 13, 0, 128]),
            ])
          : sub([code + 100, ...value]),
      );
    }
    const connection = await pending;
    const read = (maxBytes, waitMs = 500) =>
      connection.read({ maxBytes, waitMs, signal });
    const readBinary = [];
    while (readBinary.length < 5) {
      const next = await read(2);
      assert.ok(next && next.length > 0 && next.length <= 2);
      readBinary.push(...next);
    }
    assert.deepEqual(readBinary, [0, 255, 13, 0, 128]);

    const sample = Buffer.from([0, 255, 13, 10, 128]);
    assert.equal(
      await connection.write({ bytes: sample, waitMs: 500, signal }),
      sample.length,
    );
    assert.deepEqual(
      await readWire(peer, 6),
      Buffer.from([0, 255, 255, 13, 10, 128]),
    );
    await writeWire(peer, sub([108]));
    assert.equal((await read(1, 25)).length, 0);
    assert.equal(
      await connection.write({ bytes: sample, waitMs: 500, signal }),
      0,
    );
    assert.equal(peer.read(), null);
    await writeWire(peer, Buffer.concat([sub([109]), Buffer.from([65])]));
    assert.deepEqual(Buffer.from(await read(1)), Buffer.of(65));
    assert.equal(
      await connection.write({ bytes: sample, waitMs: 500, signal }),
      sample.length,
    );
    assert.deepEqual(
      await readWire(peer, 6),
      Buffer.from([0, 255, 255, 13, 10, 128]),
    );
    await assertPeerClosed(peer, stop);
    await connection.close();
  },
);

test(
  "a different baud reply rejects opening and retains both wire values",
  { timeout: 8000 },
  async (t) => {
    const { peer, pending } = await fixture(t);
    assert.deepEqual(
      await readWire(peer, openingOptions.length),
      Buffer.from(openingOptions),
    );
    await writeWire(peer, Buffer.from(acceptedOptions));
    assert.deepEqual(await readWire(peer, 10), sub([1, 0, 1, 194, 0]));
    await assertPeerClosed(peer, async () => {
      await writeWire(peer, sub([101, 0, 0, 37, 128]));
      await assert.rejects(pending, {
        name: "Rfc2217NegotiationError",
        reason: "different_value",
        field: "baudRate",
        requestedHex: "0001c200",
        replyHex: "00002580",
      });
    });
  },
);

test(
  "refused options and cancellation release the connection before serial TX",
  { timeout: 8000 },
  async (t) => {
    const refused = await fixture(t);
    await readWire(refused.peer, openingOptions.length);
    await assertPeerClosed(refused.peer, async () => {
      await writeWire(refused.peer, Buffer.from([255, 254, 44]));
      await assert.rejects(refused.pending, {
        reason: "refused",
        field: "comPort",
        replyHex: "fe2c",
      });
    });

    const cancelled = new AbortController();
    const opening = await fixture(t, {}, cancelled.signal);
    await readWire(opening.peer, openingOptions.length);
    await assertPeerClosed(opening.peer, async () => {
      cancelled.abort();
      await assert.rejects(opening.pending, { name: "AbortError" });
    });
  },
);

test(
  "a silent peer reaches the bounded open timeout and is closed",
  { timeout: 6500 },
  async (t) => {
    const { peer, pending } = await fixture(t);
    await readWire(peer, openingOptions.length);
    peer.resume();
    const ended = once(peer, "end", { signal: AbortSignal.timeout(4000) });
    await assert.rejects(pending, { reason: "timeout", field: "options" });
    await ended;
  },
);

async function configuredPeer(t, flowControl = "none") {
  const { peer, pending } = await fixture(t, { flowControl });
  assert.deepEqual(
    await readWire(peer, openingOptions.length),
    Buffer.from(openingOptions),
  );
  await writeWire(peer, Buffer.from(acceptedOptions));
  const settings = [
    [1, 0, 1, 194, 0],
    [2, 8],
    [3, 1],
    [4, 1],
    [5, flowControl === "hardware" ? 3 : 1],
  ];
  for (const [code, ...value] of settings) {
    const request = sub([code, ...value]);
    assert.deepEqual(await readWire(peer, request.length), request);
    await writeWire(peer, sub([code + 100, ...value]));
  }
  return { peer, connection: await pending };
}

test("live line control returns the actual line value and shares the stream with Raw", async (t) => {
  const { peer, connection } = await configuredPeer(t);
  t.after(() => connection.close());
  assert.equal(connection.lineControls.dtr, true);
  assert.equal(connection.lineControls.rts, true);
  const request = sub([5, 8]);
  let settled = false;
  const control = connection.lineControls.set({
    line: "dtr",
    value: true,
    waitMs: 1200,
    signal,
  });
  void control.then(
    () => {
      settled = true;
    },
    () => {},
  );
  assert.deepEqual(await readWire(peer, request.length), request);
  assert.deepEqual(
    await connection.lineControls.set({
      line: "rts",
      value: true,
      waitMs: 1200,
      signal,
    }),
    { kind: "not_applied" },
  );
  const raw = connection.read({ maxBytes: 3, waitMs: 700, signal });
  await writeWire(
    peer,
    Buffer.concat([sub([105, 12]), Buffer.from([0, 255, 255, 13])]),
  );
  assert.deepEqual(Buffer.from(await raw), Buffer.from([0, 255, 13]));
  assert.equal(settled, false);
  assert.equal(
    await connection.write({ bytes: Buffer.of(0, 255), waitMs: 500, signal }),
    2,
  );
  assert.deepEqual(await readWire(peer, 3), Buffer.of(0, 255, 255));
  const reply = sub([105, 9]);
  await writeWire(peer, reply.subarray(0, 4));
  await writeWire(peer, reply.subarray(4));
  assert.deepEqual(await control, { kind: "confirmed", actual: false });
  const second = connection.lineControls.set({
    line: "rts",
    value: true,
    waitMs: 800,
    signal,
  });
  assert.deepEqual(await readWire(peer, request.length), sub([5, 11]));
  await writeWire(peer, sub([105, 11]));
  assert.deepEqual(await second, { kind: "confirmed", actual: true });
});

test("hardware flow owns RTS and a suspended control can end before submission", async (t) => {
  const { peer, connection } = await configuredPeer(t, "hardware");
  t.after(() => connection.close());
  assert.equal(connection.lineControls.rts, false);
  assert.deepEqual(
    await connection.lineControls.set({
      line: "rts",
      value: true,
      waitMs: 400,
      signal,
    }),
    { kind: "not_applied" },
  );
  // Consume the marker after SUSPEND to prove the connection processed the pause.
  const marker = Buffer.of(0xa5);
  await writeWire(peer, Buffer.concat([sub([108]), marker]));
  assert.deepEqual(
    Buffer.from(await connection.read({ maxBytes: 1, waitMs: 500, signal })),
    marker,
  );
  const waiting = connection.lineControls.set({
    line: "dtr",
    value: true,
    waitMs: 80,
    signal,
  });
  await assert.rejects(readWire(peer, 7, 40), { name: "AbortError" });
  assert.deepEqual(await waiting, { kind: "not_applied" });
  await writeWire(peer, Buffer.concat([sub([109]), marker]));
  assert.deepEqual(
    Buffer.from(await connection.read({ maxBytes: 1, waitMs: 500, signal })),
    marker,
  );
  const resumed = connection.lineControls.set({
    line: "dtr",
    value: false,
    waitMs: 650,
    signal,
  });
  assert.deepEqual(await readWire(peer, 7), sub([5, 9]));
  await writeWire(peer, sub([105, 9]));
  assert.deepEqual(await resumed, { kind: "confirmed", actual: false });
});

test("a late acknowledgement after submission cannot become a later control result", async (t) => {
  const { peer, connection } = await configuredPeer(t);
  t.after(() => connection.close());
  const control = connection.lineControls.set({
    line: "dtr",
    value: true,
    waitMs: 160,
    signal,
  });
  const failed = assert.rejects(control, /line result is unknown/);
  assert.deepEqual(await readWire(peer, 7), sub([5, 8]));
  await assertPeerClosed(peer, async () => {
    await failed;
  });
  assert.deepEqual(
    await connection.lineControls.set({
      line: "dtr",
      value: false,
      waitMs: 500,
      signal,
    }),
    { kind: "not_applied" },
  );
});

test("the bundled RFC 2217 transport matches its signed archive and reference contract", () => {
  const root = new URL("../", import.meta.url);
  const folder = "packages/plugin-sdk/examples/reference-rfc2217/";
  const read = (path) => readFileSync(new URL(path, root));
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const manifestBytes = read(folder + "builtin-manifest.json");
  const productManifest = JSON.parse(manifestBytes);
  assert.ok(validateNodePackageManifest(productManifest));
  assert.equal(productManifest.id, builtinRfc2217PackageId);
  assert.equal(descriptor.id, builtinRfc2217PackageId);
  assert.equal(productManifest.version, descriptor.version);
  assert.equal(descriptor.sourceApproval.source, "swb.product");
  assert.equal(descriptor.manifestSha256, digest(manifestBytes));
  assert.equal(
    descriptor.archiveSha256,
    digest(read("crates/host/resources/node-packages/rfc2217.zip")),
  );
  assert.deepEqual(productManifest.permissions, manifest.permissions);
  assert.deepEqual(productManifest.contributes.transports, [
    {
      ...manifest.contributes.transports[0],
      actionId: builtinRfc2217ProviderId,
    },
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
