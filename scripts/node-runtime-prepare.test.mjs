import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { prepareNodeRuntime } from "./node-runtime-prepare.mjs";

const root = resolve(import.meta.dirname, "..");
test("refuses unknown targets and altered cached archives before extraction", (t) => {
  const cache = mkdtempSync(join(tmpdir(), "node-runtime-input-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  assert.throws(
    () =>
      prepareNodeRuntime({ root, target: "unknown", archiveDirectory: cache }),
    /target/i,
  );
  const release = JSON.parse(
    readFileSync(join(root, "resources/runtime/node-release.json"), "utf8"),
  );
  const spec = release.targets[0];
  writeFileSync(join(cache, spec.archive.name), "not the official archive");
  assert.throws(
    () =>
      prepareNodeRuntime({
        root,
        target: spec.target,
        archiveDirectory: cache,
      }),
    /archive.*size|archive.*hash/i,
  );
});

test("refuses publication outside the repository or onto its root", () => {
  const common = {
    root,
    target: "x86_64-pc-windows-msvc",
    archiveDirectory: root,
  };
  for (const outputDirectory of [root, resolve(root, "..", "outside-runtime")])
    assert.throws(
      () => prepareNodeRuntime({ ...common, outputDirectory }),
      /outside|root|publication/i,
    );
  if (process.platform === "win32")
    assert.throws(
      () =>
        prepareNodeRuntime({
          ...common,
          outputDirectory: realpathSync(root).toUpperCase(),
        }),
      /outside|root|publication/i,
    );
});
