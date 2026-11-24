import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";

const root = new URL("../", import.meta.url);
const source = "packages/plugin-sdk/examples/reference-modbus/";
const resources = new URL("crates/host/resources/node-packages/", root);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("the shipped Modbus action matches its locked bundle and the reference contract", () => {
  const descriptor = JSON.parse(
    readFileSync(new URL("modbus.json", resources), "utf8"),
  );
  const manifestBytes = readFileSync(new URL(source + "manifest.json", root));
  const manifest = JSON.parse(manifestBytes);
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "packages/plugin-sdk/examples/reference-automation/manifest.json",
        root,
      ),
      "utf8",
    ),
  );
  const referenceAction = reference.contributes.actions.find(
    (action) => action.actionId === "swb.reference.automation.modbus",
  );
  assert.ok(referenceAction);
  assert.ok(validateNodePackageManifest(manifest));
  assert.equal(descriptor.id, manifest.id);
  assert.equal(descriptor.version, manifest.version);
  assert.equal(descriptor.sourceApproval.source, "swb.product");
  assert.deepEqual(manifest.permissions, reference.permissions);
  assert.deepEqual(manifest.contributes.actions, [
    { ...referenceAction, actionId: "swb.reference.modbus.transaction" },
  ]);
  assert.equal(descriptor.manifestSha256, sha256(manifestBytes));
  assert.equal(
    descriptor.archiveSha256,
    sha256(readFileSync(new URL("modbus.zip", resources))),
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
});
