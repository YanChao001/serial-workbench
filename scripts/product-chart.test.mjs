import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";
import { register } from "../packages/plugin-sdk/examples/reference-chart/builtin.ts";
import { register as referenceRegister } from "../packages/plugin-sdk/examples/reference-chart/main.ts";

const root = new URL("../", import.meta.url);
const source = "packages/plugin-sdk/examples/reference-chart/";
const product = "crates/host/resources/node-packages/chart";
const read = (path) => readFileSync(new URL(path, root));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("the bundled chart locks the shared implementation and a separate package identity", () => {
  const descriptor = JSON.parse(read(product + ".json"));
  const manifestBytes = read(source + "builtin-manifest.json");
  const manifest = JSON.parse(manifestBytes);
  const reference = JSON.parse(read(source + "manifest.json"));
  assert.ok(validateNodePackageManifest(manifest));
  assert.equal(manifest.id, "swb.builtin.chart");
  assert.equal(manifest.id, descriptor.id);
  assert.equal(manifest.version, descriptor.version);
  assert.equal(descriptor.sourceApproval.source, "swb.product");
  assert.equal(descriptor.archiveSha256, sha256(read(product + ".zip")));
  assert.equal(descriptor.manifestSha256, sha256(manifestBytes));
  assert.equal(descriptor.viewHtmlSha256, sha256(read(source + "index.html")));
  assert.equal(descriptor.viewCssSha256, sha256(read(source + "view.css")));
  assert.deepEqual(manifest.permissions, reference.permissions);
  const registered = { actions: [], parsers: [], views: [] };
  register({
    actions: { register: (id) => registered.actions.push(id) },
    parsers: { register: (id) => registered.parsers.push(id) },
    contributions: { register: ({ views }) => registered.views.push(...views) },
  });
  assert.deepEqual(registered, {
    actions: manifest.contributes.actions.map(({ actionId }) => actionId),
    parsers: manifest.contributes.parsers.map(({ actionId }) => actionId),
    views: manifest.contributes.views.map(({ id }) => id),
  });
  for (const [entry, options, digest] of [
    [
      "builtin.ts",
      { platform: "node", target: "node26", format: "esm" },
      descriptor.compiledModuleSha256,
    ],
    ["view.ts", { format: "iife", minify: true }, descriptor.viewScriptSha256],
  ]) {
    const { outputFiles } = buildSync({
      absWorkingDir: fileURLToPath(root),
      entryPoints: [source + entry],
      bundle: true,
      write: false,
      charset: "utf8",
      legalComments: "none",
      ...options,
    });
    assert.equal(outputFiles.length, 1);
    assert.equal(sha256(outputFiles[0].contents), digest);
  }
});

test("reference and bundled CSV actions preserve decimal samples and exclusive source ranges", async () => {
  const origin = 9007199254740993n;
  const fileRead = (text, start, sequence) => ({
    kind: "rx",
    eventSeq: String(sequence),
    payload: {
      bytesBase64: Buffer.from(text).toString("base64"),
      byteStart: String(start),
      byteEnd: String(start + BigInt(text.length)),
    },
  });
  const first = "+900.00000000";
  const last = "00000001\r\n-0.5\n";
  const split = origin + BigInt(first.length);
  const eventSeq = 11n;
  const end = split + BigInt(last.length);
  const progress = [];
  const task = {
    signal: AbortSignal.timeout(2000),
    streams: {
      read: async ({ startEventSeq }) => {
        assert.equal(startEventSeq, String(eventSeq));
        return {
          events: [
            fileRead(first, origin, eventSeq),
            fileRead(last, split, eventSeq + 1n),
          ],
        };
      },
    },
    progress: { report: ({ completed }) => progress.push(completed) },
  };
  for (const [registerChart, id] of [
    [register, "swb.builtin.chart"],
    [referenceRegister, "swb.reference.chart"],
  ]) {
    const actions = new Map();
    registerChart({
      actions: { register: (name, handler) => actions.set(name, handler) },
      parsers: { register: () => {} },
      contributions: { register: () => {} },
    });
    const result = await actions.get(id + ".exportCsv")(
      {
        target: { hostId: "-data", sessionId: "port", sessionEpoch: "3" },
        params: { startEventSeq: String(eventSeq), sampleCount: 2 },
      },
      task,
    );
    assert.equal(
      Buffer.from(result, "base64").toString("utf8"),
      [
        "sample_index,value_v,host_id,session_id,session_epoch,event_start,event_end,byte_start,byte_end",
        `1,900.0000000000000001,'-data,port,3,11,13,${origin},${end - 5n}`,
        `2,-0.5,'-data,port,3,12,13,${end - 5n},${end}`,
        "",
      ].join("\r\n"),
    );
  }
  assert.deepEqual(progress, ["1", "2", "1", "2"]);
});
