import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileSha256 } from "./artifact-lib.mjs";
import { prepareMacRuntimeImage } from "./node-runtime-sign.mjs";
import { removeProjectPath } from "./fs-utils.mjs";

function fixture(t, { badPolicy = false, badFlags = false } = {}) {
  const repository = resolve(import.meta.dirname, ".."),
    parent = join(repository, ".cache", "script-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "mac-runtime-sign-"));
  t.after(() => {
    if (!t.passed) return;
    removeProjectPath(repository, relative(repository, root));
  });
  const stage = join(root, "stage"),
    resources = join(stage, "resources"),
    materials = join(resources, "runtime", "materials");
  mkdirSync(materials, { recursive: true });
  mkdirSync(join(root, "resources", "runtime"), { recursive: true });
  copyFileSync(
    join(repository, "resources/runtime/node-entitlements.plist"),
    join(root, "resources/runtime/node-entitlements.plist"),
  );
  const executable = join(resources, "node");
  writeFileSync(executable, "verified original Node");
  const spec = {
    target: "aarch64-apple-darwin",
    executable: {
      size: String(readFileSync(executable).length),
      sha256: fileSha256(executable),
    },
  };
  const calls = [];
  const run = (program, args) => {
    calls.push({ program, args });
    if (args.includes("--force"))
      writeFileSync(executable, "prepared signed Node");
    const result = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    if (args.includes("--verbose=4") && args.includes("--display"))
      result.stderr = Buffer.from(
        `CodeDirectory v=20500 flags=0x${badFlags ? "10000" : "10300"}\nCDHash=${"a".repeat(40)}\n`,
      );
    if (program === "/usr/bin/plutil")
      result.stdout = Buffer.from(
        JSON.stringify({
          "com.apple.security.cs.allow-jit": true,
          "com.apple.security.cs.allow-unsigned-executable-memory": true,
          "com.apple.security.cs.disable-library-validation": true,
          ...(badPolicy
            ? {
                "com.apple.security.cs.disable-executable-page-protection": true,
              }
            : {}),
        }),
      );
    if (program === "/usr/bin/sw_vers")
      result.stdout = Buffer.from("test-os-build\n");
    return result;
  };
  return {
    root,
    stage,
    resources,
    materials,
    executable,
    spec,
    run,
    calls,
    fingerprintCodesign: () => "b".repeat(64),
  };
}

test("macOS preparation keeps upstream bytes and emits a build-bound identity after strict policy verification", (t) => {
  const f = fixture(t),
    original = readFileSync(f.executable),
    result = prepareMacRuntimeImage(f);
  assert.deepEqual(
    readFileSync(join(f.stage, "node-upstream-original")),
    original,
  );
  assert.notEqual(result.identity.sha256, f.spec.executable.sha256);
  assert.equal(result.identity.sourceSha256, f.spec.executable.sha256);
  assert.equal(result.identity.sha256, fileSha256(f.executable));
  assert.deepEqual(
    JSON.parse(readFileSync(result.binding, "utf8")),
    result.identity,
  );
  assert.equal(result.identity.codeDirectoryHash, "a".repeat(40));
  assert.ok(f.calls.some((call) => call.args.includes("runtime,hard,kill")));
  assert.ok(f.calls.some((call) => call.args.includes("--strict")));
});
for (const [name, options] of [
  ["page-protection exception", { badPolicy: true }],
  ["missing enforcement flags", { badFlags: true }],
])
  test(`macOS preparation rejects ${name} without publishing an identity`, (t) => {
    const f = fixture(t, options);
    assert.throws(() => prepareMacRuntimeImage(f));
    assert.equal(
      existsSync(join(f.resources, "runtime/node-image.json")),
      false,
    );
    assert.ok(existsSync(join(f.stage, "node-upstream-original")));
  });
test("macOS preparation rejects altered upstream bytes before any signing command", (t) => {
  const f = fixture(t);
  writeFileSync(f.executable, "altered");
  assert.throws(() => prepareMacRuntimeImage(f), /verified source/);
  assert.equal(f.calls.length, 0);
});
