import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import * as buildTools from "./build-lib.mjs";
import {
  cargoBuildArgs,
  cargoExecutable,
  effectiveConfig,
  locateBuildOutput,
  mergeConfig,
  parseBuildArgs,
  withFreshBundle,
} from "./build-lib.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tauri-build-"));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("desktop Cargo builds select the application instead of headless default members", () => {
  assert.deepEqual(cargoBuildArgs(parseBuildArgs([]), "renamed-desktop"), [
    "--package",
    "renamed-desktop",
    "--message-format=json",
  ]);
});

test("native helpers select the desktop manifest and its current package name", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "src-tauri"));
  writeFileSync(
    join(root, "Cargo.toml"),
    '[workspace]\ndefault-members = ["crates/core"]\n',
  );
  writeFileSync(
    join(root, "src-tauri/Cargo.toml"),
    '[package]\nname = "renamed-desktop"\nversion.workspace = true\n',
  );
  assert.deepEqual(buildTools.desktopCargoArgs(root), [
    "--manifest-path",
    join(root, "src-tauri/Cargo.toml"),
    "--package",
    "renamed-desktop",
  ]);
});

test("release builds default to size and accept both explicit optimization forms", () => {
  const common = ["--features", "one", "two", "--ci"];
  const defaults = parseBuildArgs(common);
  assert.equal(defaults.optimize, "size");
  assert.deepEqual(cargoBuildArgs(defaults), [
    "--package",
    "serial-workbench",
    "--message-format=json",
  ]);
  for (const selection of [["--optimize", "size"], ["--optimize=size"]]) {
    const explicit = parseBuildArgs([...selection, ...common]);
    assert.deepEqual(explicit, defaults);
    assert.deepEqual(cargoBuildArgs(explicit), cargoBuildArgs(defaults));
  }
});

test("speed optimization supplies valid Cargo release overrides without leaking into bundle arguments", () => {
  const common = ["--config", "signing.json", "--ci"];
  for (const selection of [["--optimize", "speed"], ["--optimize=speed"]]) {
    const options = parseBuildArgs([...common, ...selection]);
    assert.equal(options.optimize, "speed");
    assert.deepEqual(options.common, common);
    const args = cargoBuildArgs(options);
    assert.equal(args.shift(), "--package");
    assert.equal(args.shift(), "serial-workbench");
    assert.equal(args.shift(), "--message-format=json");
    const overrides = [];
    while (args.length) {
      assert.equal(args.shift(), "--config");
      overrides.push(args.shift());
    }
    assert.deepEqual(
      { ...parseToml(overrides.join("\n")).profile.release },
      {
        "codegen-units": 256,
        lto: "off",
        "opt-level": 0,
        incremental: true,
        strip: false,
      },
    );
    // 解析及修改某次调用的参数不能污染后续构建。
    args.push("changed");
    assert.equal(cargoBuildArgs(options).includes("changed"), false);
    assert.deepEqual(cargoBuildArgs(parseBuildArgs([])), [
      "--package",
      "serial-workbench",
      "--message-format=json",
    ]);
  }
});

test("optimization rejects missing, invalid and repeated selections", () => {
  for (const args of [
    ["--optimize"],
    ["--optimize="],
    ["--optimize", "--ci"],
    ["--optimize", "fast"],
    ["--optimize=Speed"],
    ["--optimize", "speed", "--optimize=size"],
    ["--optimize=size", "--optimize", "size"],
  ]) {
    assert.throws(() => parseBuildArgs(args), /--optimize/);
  }
});

test("release arguments retain config order and list values for both build stages", () => {
  const options = parseBuildArgs([
    "-t",
    "x86_64-pc-windows-msvc",
    "-b",
    "nsis,msi",
    "-f",
    "one",
    "two",
    "--config",
    '{"bundle":{"active":true}}',
    "-c=signing.json",
    "--ci",
    "-vv",
    "--no-bundle",
  ]);
  assert.equal(options.target, "x86_64-pc-windows-msvc");
  assert.deepEqual(options.bundles, ["nsis", "msi"]);
  assert.deepEqual(options.configs, [
    '{"bundle":{"active":true}}',
    "signing.json",
  ]);
  assert.equal(options.noBundle, true);
  assert.equal(options.common.includes("--no-bundle"), false);
  for (const args of [
    ["--debug"],
    ["--runner", "cargo"],
    ["--", "--profile", "custom"],
    ["--target"],
    ["--bundles"],
    ["--target", "universal-apple-darwin"],
  ]) {
    assert.throws(() => parseBuildArgs(args), /pnpm tauri build/);
  }
});

test("JSON configuration uses RFC 7396 and rejects version drift or unsupported formats", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "src-tauri"));
  writeFileSync(
    join(root, "src-tauri/tauri.conf.json"),
    JSON.stringify({
      version: "1.2.3",
      app: { windows: [{ label: "old" }] },
      bundle: { active: true, targets: "all" },
    }),
  );
  writeFileSync(
    join(root, "src-tauri/tauri.windows.conf.json"),
    JSON.stringify({
      app: { windows: [{ label: "main" }] },
      bundle: { targets: ["nsis"] },
    }),
  );
  writeFileSync(
    join(root, "signing.json"),
    JSON.stringify({ bundle: { windows: { certificateThumbprint: "test" } } }),
  );
  const options = parseBuildArgs([
    "--config",
    "signing.json",
    "-c",
    '{"bundle":{"active":null}}',
  ]);
  const config = effectiveConfig(root, options, "1.2.3", "windows");
  assert.deepEqual(config.app.windows, [{ label: "main" }]);
  assert.equal(Object.hasOwn(config.bundle, "active"), false);
  assert.deepEqual(config.bundle.targets, ["nsis"]);
  assert.equal(config.bundle.windows.certificateThumbprint, "test");
  assert.throws(
    () =>
      effectiveConfig(
        root,
        parseBuildArgs(["--config", '{"version":"2.0.0"}']),
        "1.2.3",
        "windows",
      ),
    /version/,
  );
  for (const path of ["custom.toml", "custom.json5"]) {
    assert.throws(
      () =>
        effectiveConfig(
          root,
          parseBuildArgs(["--config", path]),
          "1.2.3",
          "windows",
        ),
      /only supports JSON/,
    );
  }
  const merged = mergeConfig({}, JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(merged, "__proto__"), true);
});

test("Cargo messages select the main binary and locate default or explicit target output", (t) => {
  const root = fixture(t);
  const targetDirectory = join(root, "custom-target");
  const host = "x86_64-pc-windows-msvc";
  const plan = {
    metadata: { target_directory: targetDirectory },
    package: { id: "main-app" },
    binary: { name: "app" },
    host,
    platform: "windows",
    config: { mainBinaryName: "renamed" },
  };
  const message = {
    reason: "compiler-artifact",
    package_id: "dependency",
    target: { name: "app", kind: ["bin"] },
    executable: "wrong.exe",
  };
  assert.equal(cargoExecutable(message, plan), undefined);
  message.package_id = "main-app";
  message.executable = "correct.exe";
  assert.equal(cargoExecutable(message, plan), "correct.exe");
  for (const suffix of ["release", `${host}/release`]) {
    const outputDir = join(targetDirectory, suffix);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "renamed.exe"), "application");
    const built = locateBuildOutput(plan, [join(outputDir, "app.exe")]);
    assert.equal(built.target, host);
    assert.equal(built.executable, join(outputDir, "renamed.exe"));
  }
  assert.throws(() => locateBuildOutput(plan, []), /exactly one main binary/);
  mkdirSync(join(root, "outside"));
  assert.throws(
    () => locateBuildOutput(plan, [join(root, "outside/app.exe")]),
    /outside/,
  );
});

test("fresh bundling archives only current files and retains Cargo cache", async (t) => {
  const root = fixture(t);
  const outputDir = join(root, "release");
  const old = join(outputDir, "bundle/msi/old_en-US.msi");
  mkdirSync(dirname(old), { recursive: true });
  writeFileSync(old, "old installer");
  mkdirSync(join(outputDir, "deps"));
  writeFileSync(join(outputDir, "deps/cache"), "compiler cache");
  const plan = { metadata: { target_directory: root } };
  const result = await withFreshBundle(
    plan,
    { outputDir },
    async () => {
      assert.equal(existsSync(old), false);
      mkdirSync(join(outputDir, "bundle/nsis"), { recursive: true });
      writeFileSync(
        join(outputDir, "bundle/nsis/current-setup.exe"),
        "new installer",
      );
    },
    (entries) => entries.map((entry) => entry.path),
  );
  assert.deepEqual(result, [join("nsis", "current-setup.exe")]);
  assert.equal(existsSync(old), false);
  assert.equal(
    readFileSync(join(outputDir, "deps/cache"), "utf8"),
    "compiler cache",
  );
  assert.equal(
    readdirSync(outputDir).some((name) => name.startsWith(".starter-bundle-")),
    false,
  );
});

test("failed bundling or publication restores the old installer directory", async (t) => {
  const root = fixture(t);
  const outputDir = join(root, "release");
  const old = join(outputDir, "bundle/msi/old.msi");
  mkdirSync(dirname(old), { recursive: true });
  writeFileSync(old, "known good installer");
  const plan = { metadata: { target_directory: root } };
  const executable = join(outputDir, "app.exe");
  writeFileSync(executable, "pristine application");
  for (const failPublish of [false, true]) {
    await assert.rejects(
      withFreshBundle(
        plan,
        { outputDir, executable },
        async () => {
          writeFileSync(executable, "patched application");
          mkdirSync(join(outputDir, "bundle/nsis"), { recursive: true });
          writeFileSync(
            join(outputDir, "bundle/nsis/new.exe"),
            "new installer",
          );
          if (!failPublish) throw new Error("bundle failed");
        },
        () => {
          throw new Error("publish failed");
        },
      ),
      /failed/,
    );
    assert.equal(readFileSync(old, "utf8"), "known good installer");
    assert.equal(existsSync(join(outputDir, "bundle/nsis/new.exe")), false);
    assert.equal(readFileSync(executable, "utf8"), "pristine application");
  }
});

test("bundle directory junctions cannot redirect backup or deletion", async (t) => {
  const root = fixture(t);
  const outputDir = join(root, "release");
  const outside = join(root, "outside");
  mkdirSync(outputDir);
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "do not delete");
  symlinkSync(
    outside,
    join(outputDir, "bundle"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    withFreshBundle(
      { metadata: { target_directory: root } },
      { outputDir },
      () => assert.fail("must not build"),
      () => assert.fail("must not publish"),
    ),
    /links must not redirect/,
  );
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "do not delete");
});

test("desktop build waits for components and passes the same target and sidecars to Tauri", async (t) => {
  const root = fixture(t);
  const outputDir = join(root, "target", "x86_64-pc-windows-msvc", "release");
  mkdirSync(outputDir, { recursive: true });
  const executable = join(outputDir, "desktop.exe");
  writeFileSync(executable, "desktop");
  const plan = {
    root,
    env: {},
    target: "x86_64-pc-windows-msvc",
    host: "x86_64-pc-windows-msvc",
    platform: "windows",
    version: "1.2.3",
    optimize: "size",
    metadata: { target_directory: join(root, "target") },
    package: { id: "app" },
    binary: { name: "desktop" },
    config: {},
    buildArgs: ["--no-bundle", "--"],
    bundleArgs: [],
  };
  const order = [];
  const built = await buildTools.buildApplication(plan, {
    buildComponents: async () => {
      order.push("components");
      return { files: [], manifest: { components: [] } };
    },
    stageComponents: () => ["sidecar"],
    runTauri: async (_plan, _command, args) => {
      order.push("tauri");
      assert.ok(!args.includes("--target"));
      assert.match(args.join(" "), /sidecar/);
      return [executable];
    },
  });
  assert.deepEqual(order, ["components", "tauri"]);
  assert.equal(built.target, plan.target);
  assert.match(plan.bundleArgs.join(" "), /sidecar/);
});

test("bundle manifest hashes signed component bytes from the final macOS app", async (t) => {
  const root = fixture(t);
  const outputDir = join(root, "release");
  const app = join(
    outputDir,
    "bundle",
    "macos",
    "Example.app",
    "Contents",
    "MacOS",
  );
  mkdirSync(outputDir, { recursive: true });
  const input = {
    version: "1",
    protocol: "0.1",
    target: "aarch64-apple-darwin",
    architecture: "aarch64",
    components: [
      "serial-workbench-host",
      "serial-workbench-cli",
      "serial-workbench-mcp",
    ].map((path) => ({ path, sha256: "pre-sign" })),
  };
  const manifest = await withFreshBundle(
    { metadata: { target_directory: root } },
    { outputDir },
    async () => {
      mkdirSync(app, { recursive: true });
      for (const { path } of input.components)
        writeFileSync(join(app, path), `signed-${path}`);
    },
    (entries) =>
      buildTools.distributionComponentsManifest(
        { platform: "macos" },
        input,
        entries,
      ),
  );
  assert.equal(
    manifest.components[0].sha256,
    createHash("sha256").update("signed-serial-workbench-host").digest("hex"),
  );
  assert.notEqual(manifest.components[0].sha256, "pre-sign");
});
