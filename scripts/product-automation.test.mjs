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

test("the built-in scheduled send matches the locked archive and reference action", () => {
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
  assert.deepEqual(manifest.permissions, reference.permissions);
  assert.deepEqual(manifest.dependencies, []);
  assert.deepEqual(manifest.platformResources, []);
  assert.equal(manifest.runtimeRef, reference.runtimeRef);
  const action = reference.contributes.actions.find(
    ({ actionId }) => actionId === "swb.reference.automation.repeat",
  );
  assert.ok(action);
  assert.deepEqual(manifest.contributes.actions, [
    { ...action, actionId: "swb.builtin.automation.repeat" },
  ]);
});
