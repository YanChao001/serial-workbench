import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";
import { register } from "../packages/plugin-sdk/examples/reference-chart/builtin.ts";

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
