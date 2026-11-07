import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { effectiveConfig, parseBuildArgs } from "../scripts/build-lib.mjs";
import { e2eExecutable, root as projectRoot } from "./build.mjs";
import * as e2eBuild from "./build.mjs";

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
    rmSync(root, { recursive: true, force: true });
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
