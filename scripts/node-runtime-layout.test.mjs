import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { buildApplication } from "./build-lib.mjs";
import { inspectNodeRuntimeLayout } from "./node-runtime-layout.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "runtime-output-"));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "resources/runtime"), { recursive: true });
  for (const file of ["node-release.json", "libatomic-jammy.json"])
    copyFileSync(
      resolve(import.meta.dirname, "../resources/runtime", file),
      join(root, "resources/runtime", file),
    );
  const output = join(root, "target/release"),
    resources = join(root, "prepared/resources");
  const nodePath = "runtime/node/26.13.0/x86_64-unknown-linux-gnu/bin/node";
  mkdirSync(dirname(join(resources, nodePath)), { recursive: true });
  writeFileSync(join(resources, nodePath), "verified runtime bytes fixture");
  mkdirSync(join(output, "runtime"), { recursive: true });
  writeFileSync(join(output, "runtime/old.txt"), "obsolete runtime");
  writeFileSync(join(output, "keep.txt"), "unrelated Cargo output");
  const executable = join(output, "desktop");
  const plan = {
    root,
    env: {},
    host: "x86_64-unknown-linux-gnu",
    target: "x86_64-unknown-linux-gnu",
    platform: "linux",
    version: "1.2.3",
    optimize: "size",
    metadata: { target_directory: join(root, "target") },
    package: { id: "app", name: "app" },
    binary: { name: "desktop" },
    config: { productName: "Custom Product" },
    buildArgs: ["--no-bundle", "--"],
    bundleArgs: [],
  };
  const run = () =>
    buildApplication(plan, {
      buildComponents: async () => ({
        files: [],
        manifest: { components: [] },
      }),
      stageComponents: () => [],
      buildNodeRuntime: async () => ({ resources }),
      runTauri: async () => {
        writeFileSync(executable, "desktop fixture");
        return [executable];
      },
    });
  return { root, output, resources, nodePath, run };
}

test("Linux application build stages runtime after compilation and retains unrelated output", async (t) => {
  const layout = fixture(t);
  await layout.run();
  assert.equal(
    readFileSync(join(layout.output, layout.nodePath), "utf8"),
    "verified runtime bytes fixture",
  );
  assert.equal(existsSync(join(layout.output, "runtime/old.txt")), false);
  assert.equal(
    readFileSync(join(layout.output, "keep.txt"), "utf8"),
    "unrelated Cargo output",
  );
  assert.equal(
    readFileSync(join(layout.resources, layout.nodePath), "utf8"),
    "verified runtime bytes fixture",
  );
});

test("runtime inspection excludes other application and Cargo components from its namespace and budget", (t) => {
  const layout = fixture(t);
  writeFileSync(
    join(layout.resources, "another-component.bin"),
    "separately owned component",
  );
  const files = inspectNodeRuntimeLayout(
    { root: layout.root, target: "x86_64-unknown-linux-gnu" },
    layout.resources,
  );
  assert.deepEqual(
    files.map((file) => file.path),
    [layout.nodePath],
  );
});

test("runtime input and output directory links cannot redirect build writes", async (t) => {
  const input = fixture(t);
  await input.run();
  const outside = join(input.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "private unrelated bytes");
  symlinkSync(
    outside,
    join(input.resources, "runtime/redirect"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(input.run(), /link/i);
  assert.equal(
    readFileSync(join(input.output, input.nodePath), "utf8"),
    "verified runtime bytes fixture",
  );
  assert.equal(
    readFileSync(join(outside, "keep.txt"), "utf8"),
    "private unrelated bytes",
  );

  const output = fixture(t);
  const runtime = resolve(output.output, "runtime");
  assert.equal(dirname(runtime), output.output);
  rmSync(runtime, { recursive: true });
  symlinkSync(
    outside,
    runtime,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(output.run(), /link|directory/i);
  assert.equal(
    readFileSync(join(outside, "keep.txt"), "utf8"),
    "private unrelated bytes",
  );
  assert.equal(existsSync(join(outside, "node")), false);
});

test(
  "Linux runtime staging preserves the relative SONAME link and real library mode",
  { skip: process.platform === "win32" },
  async (t) => {
    const layout = fixture(t);
    const base = "runtime/node/26.13.0/x86_64-unknown-linux-gnu/lib";
    mkdirSync(join(layout.resources, base), { recursive: true });
    const library = join(layout.resources, base, "libatomic.so.1.2.0");
    writeFileSync(library, "pinned private library fixture");
    chmodSync(library, 0o644);
    symlinkSync(
      "libatomic.so.1.2.0",
      join(layout.resources, base, "libatomic.so.1"),
    );
    await layout.run();
    assert.equal(
      readlinkSync(join(layout.output, base, "libatomic.so.1")),
      "libatomic.so.1.2.0",
    );
    assert.equal(
      statSync(join(layout.output, base, "libatomic.so.1.2.0")).mode & 0o777,
      0o644,
    );
    assert.equal(
      readFileSync(join(layout.output, base, "libatomic.so.1"), "utf8"),
      "pinned private library fixture",
    );
  },
);
