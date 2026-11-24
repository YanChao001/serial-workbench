import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";

const root = new URL("../", import.meta.url);
const examples = "packages/plugin-sdk/examples/";
const resources = new URL("crates/host/resources/node-packages/", root);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function shippedPackage(name) {
  const source = `${examples}reference-${name}/`;
  const descriptor = JSON.parse(
    readFileSync(new URL(name + ".json", resources), "utf8"),
  );
  const manifestBytes = readFileSync(new URL(source + "manifest.json", root));
  const manifest = JSON.parse(manifestBytes);
  assert.ok(validateNodePackageManifest(manifest));
  assert.equal(descriptor.id, manifest.id);
  assert.equal(descriptor.version, manifest.version);
  assert.equal(descriptor.sourceApproval.source, "swb.product");
  assert.equal(descriptor.manifestSha256, sha256(manifestBytes));
  assert.equal(
    descriptor.archiveSha256,
    sha256(readFileSync(new URL(name + ".zip", resources))),
  );
  const bundle = buildSync({
    absWorkingDir: fileURLToPath(root),
    entryPoints: [source + "main.ts"],
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
  return manifest;
}

test("the shipped Modbus action matches its locked bundle and the reference contract", () => {
  const manifest = shippedPackage("modbus");
  const reference = JSON.parse(
    readFileSync(
      new URL(examples + "reference-automation/manifest.json", root),
      "utf8",
    ),
  );
  const referenceAction = reference.contributes.actions.find(
    (action) => action.actionId === "swb.reference.automation.modbus",
  );
  assert.ok(referenceAction);
  assert.deepEqual(manifest.permissions, reference.permissions);
  assert.deepEqual(manifest.contributes.actions, [
    { ...referenceAction, actionId: "swb.reference.modbus.transaction" },
  ]);
});

test("the shipped Modbus slave uses the same model and a separate action identity", () => {
  const manifest = shippedPackage("modbus-slave");
  const reference = JSON.parse(
    readFileSync(
      new URL(examples + "reference-protocol-fields/manifest.json", root),
      "utf8",
    ),
  );
  const offline = reference.contributes.parsers.find(
    (action) => action.actionId === "swb.reference.fields.modbusServer",
  );
  assert.ok(offline);
  assert.equal(manifest.id, "swb.reference.modbus.slave");
  assert.equal(manifest.contributes.actions.length, 1);
  const [slave] = manifest.contributes.actions;
  assert.equal(slave.actionId, "swb.reference.modbus.slave.serve");
  assert.deepEqual(
    slave.inputSchema.properties.model,
    offline.inputSchema.properties.model,
  );
  assert.deepEqual(slave.targetKinds, ["session"]);
  assert.deepEqual(slave.permissions, [
    "metadata.read",
    "content.read",
    "device.modify",
  ]);
});
