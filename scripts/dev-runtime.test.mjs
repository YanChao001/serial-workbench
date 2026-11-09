import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { stageDevRuntime } from "./dev-runtime.mjs";

test("development runtimes retain independent executable versions and reject changed cached components", (t) => {
  const root = mkdtempSync(join(tmpdir(), "swb-dev-runtime-"));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const output = join(root, "target", "debug");
  mkdirSync(output, { recursive: true });
  const sources = ["serial-workbench-host.exe", "serial-workbench-cli.exe"].map(
    (name) => join(output, name),
  );
  writeFileSync(sources[0], "original Host image");
  writeFileSync(sources[1], "matching CLI image");
  for (const source of sources) chmodSync(source, 0o755);
  const original = stageDevRuntime(root, sources);
  assert.notEqual(dirname(original[0]), output);
  assert.equal(dirname(original[0]), dirname(original[1]));
  assert.equal(
    statSync(original[1]).mode & 0o111,
    statSync(sources[1]).mode & 0o111,
  );
  writeFileSync(sources[0], "rebuilt Host image");
  const next = stageDevRuntime(root, sources);
  assert.notEqual(dirname(original[0]), dirname(next[0]));
  assert.equal(readFileSync(original[0], "utf8"), "original Host image");
  assert.equal(readFileSync(next[0], "utf8"), "rebuilt Host image");
  assert.deepEqual(stageDevRuntime(root, sources), next);
  writeFileSync(next[0], "changed cached image");
  assert.throws(() => stageDevRuntime(root, sources), /component was changed/);
  assert.equal(readFileSync(next[0], "utf8"), "changed cached image");
  assert.equal(readFileSync(sources[0], "utf8"), "rebuilt Host image");
});
