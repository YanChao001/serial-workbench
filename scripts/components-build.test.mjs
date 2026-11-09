import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import * as components from "./components-build.mjs";
import { buildApplication } from "./build-lib.mjs";

test("desktop and all components accept equivalent real Cargo paths but reject different directories", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "components-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = "x86_64-pc-windows-msvc";
  const targetDir = join(root, "target");
  const output = join(targetDir, target, "release");
  mkdirSync(output, { recursive: true });
  const alias = join(root, "target-alias");
  symlinkSync(
    targetDir,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const messages = components.COMPONENTS.map((name, index) => {
    const bytes = pe();
    bytes[100] = index;
    writeFileSync(join(output, `${name}.exe`), bytes);
    return JSON.stringify({
      reason: "compiler-artifact",
      target: { name, kind: ["bin"] },
      executable: join(
        index % 2 ? targetDir : alias,
        target,
        "release",
        `${name}.exe`,
      ),
    });
  }).join("\n");
  const desktop = join(output, "desktop.exe");
  writeFileSync(desktop, "desktop");
  const plan = {
    root,
    env: {},
    host: target,
    target,
    explicitTarget: target,
    platform: "windows",
    version: "1.2.3",
    optimize: "size",
    metadata: { target_directory: alias },
    package: { id: "app" },
    binary: { name: "desktop" },
    config: {},
    buildArgs: ["--no-bundle", "--"],
    bundleArgs: [],
  };
  let receipt;
  const built = await buildApplication(plan, {
    buildComponents: async (current) => {
      receipt = await components.buildComponents(current, {
        run: async () => messages,
      });
      return receipt;
    },
    runTauri: async () => [desktop],
  });
  assert.equal(built.outputDir, realpathSync(output));
  for (const component of receipt.manifest.components)
    assert.equal(
      component.sha256,
      createHash("sha256")
        .update(readFileSync(join(output, component.path)))
        .digest("hex"),
    );
  const other = join(targetDir, "release");
  mkdirSync(other);
  const different = join(other, "desktop.exe");
  writeFileSync(different, "desktop");
  await assert.rejects(
    buildApplication(
      { ...plan, explicitTarget: undefined },
      {
        buildComponents: async () => receipt,
        runTauri: async () => [different],
      },
    ),
    /Desktop and component Cargo outputs do not match/,
  );
});

test("canonical component paths still reject another target, profile and metadata boundary", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "components-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetDir = join(root, "target");
  mkdirSync(targetDir);
  for (const suffix of [
    ["x86_64-pc-windows-msvc", "debug"],
    ["aarch64-pc-windows-msvc", "release"],
    ["..", "outside", "release"],
  ]) {
    const output = join(targetDir, ...suffix);
    mkdirSync(output, { recursive: true });
    const messages = components.COMPONENTS.map((name) => {
      const executable = join(output, `${name}.exe`);
      writeFileSync(executable, pe());
      return JSON.stringify({
        reason: "compiler-artifact",
        target: { name, kind: ["bin"] },
        executable,
      });
    }).join("\n");
    await assert.rejects(
      components.buildComponents(
        {
          root,
          explicitTarget: "x86_64-pc-windows-msvc",
          metadata: { target_directory: targetDir },
        },
        { run: async () => messages },
      ),
      /output directory|target differs/,
    );
  }
});

function pe(machine = 0x8664) {
  const data = Buffer.alloc(128);
  data.write("MZ");
  data.writeUInt32LE(64, 60);
  data.write("PE\0\0", 64);
  data.writeUInt16LE(machine, 68);
  return data;
}
test("components build first with one target and manifest hashes real bytes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "components-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "target", "x86_64-pc-windows-msvc", "release");
  mkdirSync(output, { recursive: true });
  const calls = [];
  const plan = {
    root,
    target: "x86_64-pc-windows-msvc",
    explicitTarget: "x86_64-pc-windows-msvc",
    platform: "windows",
    version: "1.2.3",
    optimize: "speed",
    env: {},
    metadata: { target_directory: join(root, "target") },
  };
  const result = await components.buildComponents(plan, {
    run: async (cmd, args) => {
      calls.push([cmd, args]);
      const messages = [];
      for (const name of components.COMPONENTS) {
        const executable = join(output, `${name}.exe`);
        writeFileSync(executable, pe());
        messages.push(
          JSON.stringify({
            reason: "compiler-artifact",
            target: { name, kind: ["bin"] },
            executable,
          }),
        );
      }
      return messages.join("\n");
    },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0][1].includes("--target"));
  assert.equal(calls[0][1][calls[0][1].indexOf("--target") + 1], plan.target);
  assert.equal(result.manifest.protocol, "0.1");
  assert.equal(result.manifest.components.length, 3);
  assert.equal(
    result.manifest.components[0].sha256,
    createHash("sha256")
      .update(readFileSync(result.files[0].source))
      .digest("hex"),
  );
});
test("packaging rejects missing and wrong architecture components", (t) => {
  const root = mkdtempSync(join(tmpdir(), "components-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = {
    version: "1",
    target: "x86_64-pc-windows-msvc",
    platform: "windows",
  };
  assert.throws(() => components.inspectComponents(plan, root), /missing/i);
  for (const name of components.COMPONENTS)
    writeFileSync(join(root, `${name}.exe`), pe(0xaa64));
  assert.throws(
    () => components.inspectComponents(plan, root),
    /architecture/i,
  );
});

test("ELF and Mach-O metadata must match the target format and architecture", (t) => {
  const root = mkdtempSync(join(tmpdir(), "components-unix-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const elf = Buffer.alloc(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  elf.writeUInt16LE(62, 18);
  const macho = Buffer.alloc(32);
  macho.writeUInt32LE(0xfeedfacf);
  macho.writeUInt32LE(0x0100000c, 4);
  const write = (data) => {
    for (const name of components.COMPONENTS)
      writeFileSync(join(root, name), data);
  };
  write(elf);
  assert.equal(
    components.inspectComponents(
      { version: "1", target: "x86_64-unknown-linux-gnu", platform: "linux" },
      root,
    ).files.length,
    3,
  );
  elf[4] = 1;
  write(elf);
  assert.throws(
    () =>
      components.inspectComponents(
        { version: "1", target: "x86_64-unknown-linux-gnu", platform: "linux" },
        root,
      ),
    /architecture/i,
  );
  write(macho);
  assert.equal(
    components.inspectComponents(
      { version: "1", target: "aarch64-apple-darwin", platform: "macos" },
      root,
    ).files.length,
    3,
  );
  assert.throws(
    () =>
      components.inspectComponents(
        { version: "1", target: "x86_64-apple-darwin", platform: "macos" },
        root,
      ),
    /architecture/i,
  );
});

test("implicit Cargo target follows emitted artifacts without overriding config or cache", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "components-target-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = "x86_64-apple-darwin";
  const dir = join(root, "target", target, "release");
  mkdirSync(dir, { recursive: true });
  const macho = Buffer.alloc(32);
  macho.writeUInt32LE(0xfeedfacf);
  macho.writeUInt32LE(0x01000007, 4);
  const plan = {
    root,
    host: "aarch64-apple-darwin",
    version: "1",
    optimize: "size",
    env: {},
    metadata: { target_directory: join(root, "target") },
  };
  const result = await components.buildComponents(plan, {
    run: async (_cmd, args) => {
      assert.ok(!args.includes("--target"));
      return components.COMPONENTS.map((name) => {
        const executable = join(dir, name);
        writeFileSync(executable, macho);
        return JSON.stringify({
          reason: "compiler-artifact",
          target: { name, kind: ["bin"] },
          executable,
        });
      }).join("\n");
    },
  });
  assert.equal(result.target, target);
  assert.equal(result.outputDir, dir);
  assert.equal(result.manifest.architecture, "x86_64");
});

test("implicit host uses Cargo's unqualified release directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "components-default-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outputDir = join(root, "target", "release");
  mkdirSync(outputDir, { recursive: true });
  const host = "x86_64-pc-windows-msvc";
  const plan = {
    root,
    host,
    version: "1",
    optimize: "size",
    env: {},
    metadata: { target_directory: join(root, "target") },
  };
  const result = await components.buildComponents(plan, {
    run: async (_cmd, args) => {
      assert.ok(!args.includes("--target"));
      return components.COMPONENTS.map((name) => {
        const executable = join(outputDir, `${name}.exe`);
        writeFileSync(executable, pe());
        return JSON.stringify({
          reason: "compiler-artifact",
          target: { name, kind: ["bin"] },
          executable,
        });
      }).join("\n");
    },
  });
  assert.equal(result.target, host);
  assert.equal(result.outputDir, outputDir);
});
