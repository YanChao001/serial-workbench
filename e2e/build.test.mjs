import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { effectiveConfig, parseBuildArgs } from "../scripts/build-lib.mjs";
import { e2eExecutable, root as projectRoot } from "./build.mjs";
import * as e2eBuild from "./build.mjs";
import { fileSha256 } from "../scripts/artifact-lib.mjs";

test("E2E builds all adjacent Host entrypoints for the same explicit target", () => {
  assert.deepEqual(e2eBuild.e2eHostBuildArgs("x86_64-pc-windows-msvc"), [
    "build",
    "--locked",
    "--target",
    "x86_64-pc-windows-msvc",
    "--package",
    "serial-workbench-host",
    "--package",
    "serial-workbench-cli",
    "--package",
    "serial-workbench-mcp",
    "--bins",
  ]);
});

test("E2E source identity is stable across Gitlink checkout states and detects nested HEAD changes", (t) => {
  const { root } = fixture(t);
  const nested = join(root, "marketplace");
  const backup = join(root, ".saved-plugin");
  assert.equal(dirname(nested), root);
  assert.equal(dirname(backup), root);
  const git = (cwd, ...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        "advice.addEmbeddedRepo=false",
        ...args,
      ],
      { cwd, encoding: "utf8", windowsHide: true },
    ).trim();
  git(root, "init", "--quiet");
  mkdirSync(nested);
  git(nested, "init", "--quiet");
  writeFileSync(join(nested, "plugin.txt"), "first plugin source");
  git(nested, "add", "plugin.txt");
  git(nested, "commit", "--quiet", "-m", "fixture plugin");
  writeFileSync(join(root, ".gitignore"), ".saved-plugin/\n");
  git(root, "add", "--", ".gitignore", "src-tauri");
  git(
    root,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${git(nested, "rev-parse", "HEAD")},marketplace`,
  );
  git(root, "commit", "--quiet", "-m", "fixture root");
  const initialized = e2eBuild.e2eSourceIdentity(root);
  renameSync(nested, backup);
  mkdirSync(nested);
  assert.equal(
    e2eBuild.e2eSourceIdentity(root),
    initialized,
    "empty checkout must use the indexed Gitlink, never the parent HEAD",
  );
  writeFileSync(join(nested, "unidentified.txt"), "unverified exported source");
  assert.throws(
    () => e2eBuild.e2eSourceIdentity(root),
    /无法识别 E2E 源目录身份/,
  );
  unlinkSync(join(nested, "unidentified.txt"));
  rmdirSync(nested);
  assert.equal(
    e2eBuild.e2eSourceIdentity(root),
    initialized,
    "absent checkout has the same indexed source",
  );
  renameSync(backup, nested);
  writeFileSync(join(nested, "plugin.txt"), "next plugin source");
  git(nested, "add", "plugin.txt");
  git(nested, "commit", "--quiet", "-m", "next plugin");
  assert.notEqual(
    e2eBuild.e2eSourceIdentity(root),
    initialized,
    "an initialized checkout must still identify its actual HEAD",
  );
});

test("E2E rejects changed source, missing or substituted adjacent components and target/profile escapes", (t) => {
  const { root } = fixture(t);
  execFileSync("git", ["init", "--quiet", root], { windowsHide: true });
  writeFileSync(join(root, ".gitignore"), "src-tauri/target/\n");
  const sourcePath = join(root, "source.rs");
  writeFileSync(sourcePath, "candidate source");
  const target = "x86_64-pc-windows-msvc";
  const output = join(root, "src-tauri/target/e2e", target, "debug");
  mkdirSync(output, { recursive: true });
  const executable = join(output, "desktop.exe");
  writeFileSync(executable, "desktop candidate");
  const components = [
    "serial-workbench-host",
    "serial-workbench-cli",
    "serial-workbench-mcp",
  ].map((name) => {
    const path = join(output, name + ".exe");
    writeFileSync(path, name);
    return { name, path, sha256: fileSha256(path) };
  });
  const receipt = {
    formatVersion: 2,
    target,
    executable,
    sha256: fileSha256(executable),
    source: e2eBuild.e2eSourceIdentity(root),
    components,
  };
  const save = (value = receipt) =>
    writeFileSync(
      join(root, "src-tauri/target/e2e/build.json"),
      JSON.stringify(value),
    );
  save();
  assert.deepEqual(e2eBuild.readE2EBuildReceipt(root), receipt);
  writeFileSync(sourcePath, "newer source");
  assert.throws(() => e2eBuild.readE2EBuildReceipt(root), /构建收据失效/);
  writeFileSync(sourcePath, "candidate source");
  writeFileSync(components[0].path, "older Host");
  assert.throws(() => e2eBuild.readE2EBuildReceipt(root), /构建收据失效/);
  writeFileSync(components[0].path, components[0].name);
  for (const patch of [
    { target: "../outside" },
    { components: components.slice(1) },
    { executable: join(output, "../release/desktop.exe") },
    { components: [components[0], components[0], components[2]] },
  ]) {
    save({ ...receipt, ...patch });
    assert.throws(() => e2eBuild.readE2EBuildReceipt(root), /构建收据失效/);
  }
});

test("E2E build selects the desktop package alongside its isolated configuration", () => {
  assert.deepEqual(
    e2eBuild.e2eBuildArgs("x86_64-pc-windows-msvc", "desktop-app"),
    [
      "build",
      "--debug",
      "--no-bundle",
      "--target",
      "x86_64-pc-windows-msvc",
      "--features",
      "e2e",
      "--config",
      "src-tauri/tauri.e2e.conf.json",
      "--",
      "--package",
      "desktop-app",
    ],
  );
});

test("all desktop E2E profiles resolve named capabilities and retain the driver", () => {
  const version = JSON.parse(
    readFileSync(join(projectRoot, "package.json"), "utf8"),
  ).version;
  const capabilityDirectory = join(projectRoot, "src-tauri/capabilities");
  const identifiers = new Set(
    readdirSync(capabilityDirectory)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) =>
          JSON.parse(readFileSync(join(capabilityDirectory, name), "utf8"))
            .identifier,
      ),
  );
  const options = parseBuildArgs(["--config", "src-tauri/tauri.e2e.conf.json"]);
  for (const platform of ["windows", "macos", "linux"]) {
    const capabilities = effectiveConfig(
      projectRoot,
      options,
      version,
      platform,
    ).app.security.capabilities;
    for (const capability of capabilities) {
      if (typeof capability === "string")
        assert.ok(
          identifiers.has(capability),
          `${platform}: missing named capability ${capability}`,
        );
    }
    assert.ok(
      capabilities.some(
        (capability) =>
          typeof capability === "object" &&
          capability?.identifier === "e2e-driver" &&
          capability.permissions.includes("wdio-webdriver:default"),
      ),
      `${platform}: E2E driver capability must remain enabled`,
    );
  }
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tauri-e2e-build-"));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    if (process.platform === "win32") makeFixtureFilesWritable(root);
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  mkdirSync(join(root, "src-tauri"));
  const config = (name, value) =>
    writeFileSync(join(root, "src-tauri", name), JSON.stringify(value));
  config("tauri.conf.json", { version: "1.2.3" });
  config("tauri.e2e.conf.json", {});
  const pkg = {
    name: "app-package",
    version: "1.2.3",
    targets: [{ name: "desktop", kind: ["bin"] }],
  };
  return { root, pkg, config };
}

function makeFixtureFilesWritable(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) makeFixtureFilesWritable(path);
    else if (entry.isFile()) chmodSync(path, 0o600);
  }
}

test("E2E resolves Cargo's actual binary and platform-specific Tauri renames", (t) => {
  const { root, pkg, config } = fixture(t);
  const target = "x86_64-pc-windows-msvc";
  const directory = join(root, "src-tauri/target/e2e", target, "debug");
  assert.equal(
    e2eExecutable(root, target, pkg),
    join(directory, "desktop.exe"),
  );
  config("tauri.windows.conf.json", { mainBinaryName: "platform-app" });
  assert.equal(
    e2eExecutable(root, target, pkg),
    join(directory, "platform-app.exe"),
  );
  config("tauri.e2e.conf.json", { mainBinaryName: "test-app" });
  assert.equal(
    e2eExecutable(root, target, pkg),
    join(directory, "test-app.exe"),
  );
  config("tauri.e2e.conf.json", { mainBinaryName: "../outside" });
  assert.throws(() => e2eExecutable(root, target, pkg), /single file name/);
});

test("E2E respects default-run and does not append exe on Unix", (t) => {
  const { root, pkg } = fixture(t);
  pkg.targets.push({ name: "helper", kind: ["bin"] });
  assert.throws(
    () => e2eExecutable(root, "aarch64-apple-darwin", pkg),
    /default-run/,
  );
  pkg.default_run = "desktop";
  for (const target of ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"])
    assert.equal(
      e2eExecutable(root, target, pkg),
      join(root, "src-tauri/target/e2e", target, "debug/desktop"),
    );
});
