import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";

const root = new URL("../", import.meta.url);
const directory = new URL("crates/host/resources/node-packages/", root);
const source = "packages/plugin-sdk/examples/reference-protocol-fields/";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("the shipped field archive matches the locked SDK bundle and manifest", () => {
  const descriptor = JSON.parse(
    readFileSync(new URL("protocol-fields.json", directory), "utf8"),
  );
  const manifestBytes = readFileSync(new URL(source + "manifest.json", root));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(validateNodePackageManifest(manifest), true);
  assert.equal(descriptor.id, manifest.id);
  assert.equal(descriptor.version, manifest.version);
  assert.equal(descriptor.manifestSha256, sha256(manifestBytes));
  assert.equal(
    descriptor.archiveSha256,
    sha256(readFileSync(new URL("protocol-fields.zip", directory))),
  );
  const bundle = buildSync({
    absWorkingDir: fileURLToPath(root),
    entryPoints: [source + "main.ts"],
    bundle: true,
    platform: "browser",
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
