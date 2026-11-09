import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { portableArtifactEntries } from "./portable.mjs";
import { publishArtifacts } from "./artifact-lib.mjs";
import { inspectComponents } from "./components-build.mjs";
import {
  loadPortableBuild,
  portableFileName,
  recordPortableBuild,
} from "./portable-lib.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tauri-portable-receipt-"));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const targetDirectory = join(root, "custom-target");
  const executable = join(targetDirectory, "release/app.exe");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "fresh portable program");
  const plan = {
    root,
    target: "x86_64-pc-windows-msvc",
    platform: "windows",
    version: "1.2.3",
    config: { productName: "Desktop App" },
    optimize: "size",
    buildArgs: ["--no-bundle"],
    metadata: { target_directory: targetDirectory },
  };
  const built = {
    executable,
    outputDir: dirname(executable),
    target: "x86_64-pc-windows-msvc",
  };
  const pe = Buffer.alloc(128);
  pe.write("MZ");
  pe.writeUInt32LE(64, 60);
  pe.write("PE\0\0", 64);
  pe.writeUInt16LE(0x8664, 68);
  for (const name of [
    "serial-workbench-host",
    "serial-workbench-cli",
    "serial-workbench-mcp",
  ])
    writeFileSync(join(built.outputDir, `${name}.exe`), pe);
  built.components = inspectComponents(plan, built.outputDir);
  return { root, plan, built };
}

test("portable distribution includes complete project licenses and existing third-party notices", (t) => {
  const { root, plan, built } = fixture(t);
  const projectRoot = resolve(import.meta.dirname, "..");
  const entries = portableArtifactEntries(projectRoot, {
    executable: built.executable,
    executableName: "Serial Workbench.exe",
    readme: "Portable distribution fixture\n",
  });
  const output = publishArtifacts(root, {
    version: plan.version,
    target: built.target,
    kind: "portable",
    entries,
  });
  for (const path of ["LICENSE", "NOTICE"]) {
    assert.ok(
      existsSync(join(output, path)),
      `Portable package omitted ${path}`,
    );
    assert.deepEqual(
      readFileSync(join(output, path)),
      readFileSync(join(projectRoot, path)),
    );
  }
  assert.equal(existsSync(join(output, "LICENSES")), false);
  assert.deepEqual(
    readFileSync(join(output, "third-party/tauri.LICENSE")),
    readFileSync(join(projectRoot, "resources/third-party/tauri.LICENSE")),
  );
  const manifest = JSON.parse(
    readFileSync(join(output, "manifest.json"), "utf8"),
  );
  for (const path of ["LICENSE", "NOTICE"]) {
    assert.ok(
      manifest.files.some((file) => file.path === path),
      `Manifest omitted ${path}`,
    );
  }
});

test("portable receipt follows the actual Cargo output without forcing a second target cache", (t) => {
  const { plan, built } = fixture(t);
  recordPortableBuild(plan, built);
  assert.deepEqual(loadPortableBuild(plan), built);
  assert.equal(portableFileName("Desktop App"), "Desktop App.exe");
});

test("portable receipts reuse the same optimization and reject both strategy changes", (t) => {
  const { plan, built } = fixture(t);
  for (const optimize of ["speed", "size"]) {
    const selected = { ...plan, optimize };
    recordPortableBuild(selected, built);
    assert.deepEqual(loadPortableBuild({ ...selected }), built);
    assert.throws(
      () =>
        loadPortableBuild({
          ...selected,
          optimize: optimize === "speed" ? "size" : "speed",
        }),
      /has changed/,
    );
  }
});

test("skip-build rejects absent receipts, configuration drift and rewritten executables", (t) => {
  const { plan, built } = fixture(t);
  assert.throws(() => loadPortableBuild(plan), /Cannot skip the build/);
  recordPortableBuild(plan, built);
  assert.throws(
    () => loadPortableBuild({ ...plan, version: "1.2.4" }),
    /has changed/,
  );
  assert.throws(
    () => loadPortableBuild({ ...plan, config: { productName: "Other App" } }),
    /has changed/,
  );
  assert.throws(
    () =>
      loadPortableBuild({
        ...plan,
        buildArgs: ["--features", "other", "--no-bundle"],
      }),
    /has changed/,
  );
  writeFileSync(built.executable, "patched by installer bundling");
  assert.throws(() => loadPortableBuild(plan), /has changed/);
});

test("portable filenames reject path traversal and reserved Windows names", () => {
  for (const name of [
    "../other",
    "..\\other",
    "NUL",
    "COM1.log",
    "app.",
    "app ",
    "app:name",
  ])
    assert.throws(() => portableFileName(name), /Windows/);
});

test("portable receipt rejects changed or missing release components", (t) => {
  const { plan, built } = fixture(t);
  plan.target = built.target;
  plan.platform = "windows";
  const pe = Buffer.alloc(128);
  pe.write("MZ");
  pe.writeUInt32LE(64, 60);
  pe.write("PE\0\0", 64);
  pe.writeUInt16LE(0x8664, 68);
  for (const name of [
    "serial-workbench-host",
    "serial-workbench-cli",
    "serial-workbench-mcp",
  ])
    writeFileSync(join(built.outputDir, `${name}.exe`), pe);
  built.components = inspectComponents(plan, built.outputDir);
  recordPortableBuild(plan, built);
  assert.deepEqual(
    loadPortableBuild(plan).components.manifest,
    built.components.manifest,
  );
  writeFileSync(
    join(built.outputDir, "serial-workbench-host.exe"),
    Buffer.concat([pe, Buffer.from("changed")]),
  );
  assert.throws(() => loadPortableBuild(plan), /changed/);
  rmSync(join(built.outputDir, "serial-workbench-host.exe"));
  assert.throws(() => loadPortableBuild(plan), /Missing component/i);
});

test("portable distribution puts components and their manifest beside the client", (t) => {
  const { root, built } = fixture(t);
  const projectRoot = resolve(import.meta.dirname, "..");
  const entries = portableArtifactEntries(projectRoot, {
    executable: built.executable,
    executableName: "Desktop.exe",
    readme: "fixture",
    components: built.components,
  });
  const output = publishArtifacts(root, {
    version: "1.2.3",
    target: built.target,
    kind: "portable",
    entries,
  });
  for (const { path } of built.components.files)
    assert.ok(existsSync(join(output, path)));
  assert.deepEqual(
    JSON.parse(readFileSync(join(output, "components.json"), "utf8")),
    built.components.manifest,
  );
});

test("skip-build reuses the receipt target without guessing the current host", (t) => {
  const { plan, built } = fixture(t);
  recordPortableBuild(plan, built);
  const result = loadPortableBuild({
    ...plan,
    target: "aarch64-pc-windows-msvc",
    host: "aarch64-pc-windows-msvc",
  });
  assert.equal(result.target, built.target);
  assert.throws(
    () =>
      loadPortableBuild({ ...plan, explicitTarget: "aarch64-pc-windows-msvc" }),
    /target/i,
  );
});
