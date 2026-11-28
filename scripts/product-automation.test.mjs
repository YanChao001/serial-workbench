import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";

const root = new URL("../", import.meta.url);
const source = "packages/plugin-sdk/examples/reference-automation/";
const packages = new URL("crates/host/resources/node-packages/", root);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("the built-in automation matches the locked archive and the reference actions", () => {
  const manifestBytes = readFileSync(
    new URL(source + "builtin-manifest.json", root),
  );
  const manifest = JSON.parse(manifestBytes);
  const reference = JSON.parse(
    readFileSync(new URL(source + "manifest.json", root), "utf8"),
  );
  const descriptor = JSON.parse(
    readFileSync(new URL("automation.json", packages), "utf8"),
  );
  assert.ok(validateNodePackageManifest(manifest));
  assert.equal(descriptor.id, manifest.id);
  assert.equal(descriptor.version, manifest.version);
  assert.equal(descriptor.sourceApproval.source, "swb.product");
  assert.equal(
    descriptor.archiveSha256,
    sha256(readFileSync(new URL("automation.zip", packages))),
  );
  assert.equal(descriptor.manifestSha256, sha256(manifestBytes));
  const bundle = buildSync({
    absWorkingDir: fileURLToPath(root),
    entryPoints: [source + "builtin.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    charset: "utf8",
    legalComments: "none",
    write: false,
  });
  assert.equal(bundle.outputFiles.length, 1);
  assert.equal(
    descriptor.compiledModuleSha256,
    sha256(bundle.outputFiles[0].contents),
  );
  assert.deepEqual(manifest.permissions, {
    ...reference.permissions,
    hostApi: [
      ...reference.permissions.hostApi,
      {
        permissions: ["metadata.read", "device.modify"],
        targetKinds: ["device"],
      },
    ],
  });
  assert.deepEqual(manifest.dependencies, []);
  assert.deepEqual(manifest.platformResources, []);
  assert.equal(manifest.runtimeRef, reference.runtimeRef);
  const actions = ["repeat", "sequence", "rule", "calendar"].map((name) => {
    const action = reference.contributes.actions.find(
      ({ actionId }) => actionId === "swb.reference.automation." + name,
    );
    assert.ok(action);
    return { ...action, actionId: "swb.builtin.automation." + name };
  });
  const [loopback, connection, script] = manifest.contributes.actions.slice(-3);
  assert.equal(loopback.actionId, "swb.builtin.automation.loopback");
  assert.deepEqual(loopback.targetKinds, ["session"]);
  assert.deepEqual(
    loopback.permissions,
    manifest.permissions.hostApi[0].permissions,
  );
  assert.equal(connection.actionId, "swb.builtin.automation.connect");
  assert.deepEqual(connection.targetKinds, ["device"]);
  assert.deepEqual(
    connection.permissions,
    manifest.permissions.hostApi[1].permissions,
  );
  assert.equal(script.actionId, "swb.builtin.automation.script");
  assert.deepEqual(script.targetKinds, ["session"]);
  assert.deepEqual(
    script.permissions,
    manifest.permissions.hostApi[0].permissions,
  );
  const sequence = manifest.contributes.actions.find(
    ({ actionId }) => actionId === "swb.builtin.automation.sequence",
  );
  assert.equal(sequence.inputSchema.properties.fileBindings.type, "array");
  assert.equal(sequence.inputSchema.properties.fileBindings.maxItems, 32);
  const productActions = manifest.contributes.actions.map((entry) => {
    if (entry !== sequence) return entry;
    const { fileBindings, ...properties } = entry.inputSchema.properties;
    return { ...entry, inputSchema: { ...entry.inputSchema, properties } };
  });
  assert.deepEqual(productActions, [...actions, loopback, connection, script]);
});
