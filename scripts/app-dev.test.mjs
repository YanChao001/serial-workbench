import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { runDev } from "./app-dev.mjs";
import { buildEnvironment } from "./build-lib.mjs";

const root = resolve("/project");
const output = resolve("/external cache/custom-target/custom-profile");
const host = join(output, "serial-workbench-host.exe");
const cli = join(output, "serial-workbench-cli.exe");
const runtimeDirectory = resolve("/immutable runtime/version");
const runtimeCli = join(runtimeDirectory, "serial-workbench-cli.exe");

function artifact(name, executable, extra = {}) {
  return JSON.stringify({
    reason: "compiler-artifact",
    package_id: `path+file:///project/crates/${name}#0.1.0`,
    manifest_path: `/project/crates/${name}/Cargo.toml`,
    target: {
      kind: ["bin"],
      crate_types: ["bin"],
      name,
      src_path: `/project/crates/${name}/src/main.rs`,
      edition: "2024",
      doc: true,
      doctest: false,
      test: true,
    },
    profile: {
      opt_level: "0",
      debuginfo: 2,
      debug_assertions: true,
      overflow_checks: true,
      test: false,
    },
    features: [],
    filenames: [executable],
    executable,
    fresh: false,
    ...extra,
  });
}

const artifacts = [
  artifact("serial-workbench-host", host),
  artifact("serial-workbench-cli", cli),
];

function runner({ lines = artifacts, buildCode = 0, cliCode = 0 } = {}) {
  const calls = [];
  return {
    calls,
    stageRuntime: (_root, sources) => {
      assert.deepEqual(sources, [host, cli]);
      return [join(runtimeDirectory, "serial-workbench-host.exe"), runtimeCli];
    },
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === "cargo") {
        for (const line of lines) opts.onStdoutLine?.(line);
        return buildCode;
      }
      if (cmd === runtimeCli) return cliCode;
      return 0;
    },
  };
}

test("dev builds Host and CLI, authenticates the immutable runtime CLI, then starts Tauri", async () => {
  const fixture = runner();
  assert.equal(await runDev(root, ["--no-watch"], fixture), 0);
  const [build, prepare, tauri] = fixture.calls;
  assert.equal(fixture.calls.length, 3);
  assert.equal(build.cmd, "cargo");
  assert.deepEqual(build.args, [
    "build",
    "--locked",
    "--message-format=json",
    "--manifest-path",
    join(root, "Cargo.toml"),
    "--package",
    "serial-workbench-host",
    "--package",
    "serial-workbench-cli",
  ]);
  assert.equal(prepare.cmd, runtimeCli);
  assert.deepEqual(prepare.args, ["catalog", "--json"]);
  assert.deepEqual(prepare.opts.stdio, ["ignore", "ignore", "inherit"]);
  assert.deepEqual(build.opts.stdio, ["ignore", "pipe", "inherit"]);
  assert.deepEqual(tauri.args.slice(-2), ["dev", "--no-watch"]);
  assert.equal(tauri.cmd, process.execPath);
  assert.equal(build.opts.cwd, join(root, "src-tauri"));
  assert.equal(prepare.opts.cwd, build.opts.cwd);
  assert.equal(tauri.opts.cwd, root);
  assert.deepEqual(build.opts.env, buildEnvironment());
  assert.equal(prepare.opts.env, build.opts.env);
  assert.equal(tauri.opts.env, build.opts.env);
  for (const call of fixture.calls) {
    assert.equal(call.opts.windowsHide, true);
    assert.equal(call.opts.shell, false);
  }
});

test("dev preserves relative data profile and does not pass a separate CLI profile", async (t) => {
  const original = process.env.SWB_PROFILE;
  t.after(() => {
    if (original === undefined) delete process.env.SWB_PROFILE;
    else process.env.SWB_PROFILE = original;
  });
  process.env.SWB_PROFILE = "../temporary profile";
  const fixture = runner();
  await runDev(root, [], fixture);
  assert.equal(fixture.calls.length, 3);
  for (const call of fixture.calls)
    assert.equal(call.opts.env.SWB_PROFILE, "../temporary profile");
  assert.deepEqual(fixture.calls[1].args, ["catalog", "--json"]);
  assert.equal(fixture.calls[1].opts.cwd, join(root, "src-tauri"));
});

test("dev propagates explicit target and release and stops on build failure", async () => {
  const fixture = runner({ buildCode: 4 });
  assert.equal(
    await runDev(
      root,
      ["--target", "x86_64-apple-darwin", "--release"],
      fixture,
    ),
    4,
  );
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0].args.slice(-3), [
    "--target",
    "x86_64-apple-darwin",
    "--release",
  ]);
});

test("dev stops before Tauri when CLI authentication fails", async () => {
  const fixture = runner({ cliCode: 7 });
  assert.equal(await runDev(root, [], fixture), 7);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[1].cmd, runtimeCli);
});

test("dev stops before authentication and Tauri if runtime staging fails", async () => {
  const fixture = runner();
  const failure = new Error("changed cached runtime");
  await assert.rejects(
    runDev(root, [], {
      ...fixture,
      stageRuntime() {
        throw failure;
      },
    }),
    failure,
  );
  assert.equal(fixture.calls.length, 1);
});

test("dev propagates preparation spawn errors before Tauri", async () => {
  const fixture = runner();
  const failure = new Error("CLI could not start");
  const run = async (...args) => {
    if (args[0] === runtimeCli) throw failure;
    return fixture.run(...args);
  };
  await assert.rejects(
    runDev(root, [], { run, stageRuntime: fixture.stageRuntime }),
    failure,
  );
  assert.equal(fixture.calls.length, 1);
});

test("dev preserves Cargo selections and the second separator application arguments", async () => {
  const fixture = runner();
  const args = [
    "--no-watch",
    "--release",
    "--",
    "--config",
    'build.target="x86_64-unknown-linux-gnu"',
    "--profile",
    "custom",
    "--target-dir",
    "cache",
    "--",
    "--target",
    "application-target",
    "--profile",
    "application-profile",
  ];
  await runDev(root, args, fixture);
  assert.equal(fixture.calls.length, 3);
  assert.deepEqual(fixture.calls[0].args.slice(-6), [
    "--config",
    'build.target="x86_64-unknown-linux-gnu"',
    "--profile",
    "custom",
    "--target-dir",
    "cache",
  ]);
  assert.ok(!fixture.calls[0].args.includes("--release"));
  assert.ok(!fixture.calls[0].args.includes("application-target"));
  assert.deepEqual(fixture.calls[2].args.slice(-args.length), args);
});

test("dev accepts compact target and equals Cargo selections without rewriting Tauri args", async () => {
  for (const argument of ["-tx86_64-apple-darwin", "-t=x86_64-apple-darwin"]) {
    const fixture = runner();
    const args = [
      argument,
      "--",
      "--target-dir=cache",
      "--profile=custom",
      "--config=build.jobs=2",
    ];
    await runDev(root, args, fixture);
    assert.equal(fixture.calls.length, 3);
    assert.deepEqual(fixture.calls[0].args.slice(-8), [
      "--target",
      "x86_64-apple-darwin",
      "--target-dir",
      "cache",
      "--profile",
      "custom",
      "--config",
      "build.jobs=2",
    ]);
    assert.deepEqual(fixture.calls[2].args.slice(-args.length), args);
  }
});

test("dev propagates Cargo target and release selection", async () => {
  const fixture = runner();
  await runDev(
    root,
    ["--", "--target=x86_64-pc-windows-msvc", "--release"],
    fixture,
  );
  assert.deepEqual(fixture.calls[0].args.slice(-3), [
    "--target",
    "x86_64-pc-windows-msvc",
    "--release",
  ]);
});

test("dev help forwards to Tauri without build or authentication", async () => {
  for (const argument of ["--help", "-h"]) {
    const fixture = runner();
    await runDev(root, [argument], fixture);
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.calls[0].args.slice(-2), ["dev", argument]);
  }
});

test("dev rejects custom runners and workspace package switches before launching", async () => {
  for (const args of [
    ["-rcustom"],
    ["-r=custom"],
    ["--runner", "custom"],
    ["--runner=custom"],
    ["--", "--package", "other"],
    ["--", "--workspace"],
  ]) {
    const fixture = runner();
    await assert.rejects(runDev(root, args, fixture), /cannot synchronize/);
    assert.equal(fixture.calls.length, 0);
  }
});

test("dev accepts identical cached artifacts without guessing their output directory", async () => {
  const fixture = runner({
    lines: [
      "",
      "null",
      ...artifacts,
      ...artifacts.map((line) =>
        JSON.stringify({ ...JSON.parse(line), fresh: true }),
      ),
      JSON.stringify({ reason: "build-finished", success: true }),
    ],
  });
  await runDev(root, [], fixture);
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.calls[1].cmd, runtimeCli);
});

test("dev refuses missing, non-bin, invalid, ambiguous or non-adjacent executables", async () => {
  for (const lines of [
    [],
    [artifacts[0]],
    [artifacts[0], artifact("serial-workbench-cli", null)],
    [artifacts[0], artifact("serial-workbench-cli", "")],
    [artifacts[0], artifact("serial-workbench-cli", "relative/cli")],
    [
      artifacts[0],
      artifact("serial-workbench-cli", cli, {
        target: { name: "serial-workbench-cli", kind: ["lib"] },
      }),
    ],
    [
      ...artifacts,
      artifact("serial-workbench-cli", join(output, "another-cli.exe")),
    ],
    [
      artifacts[0],
      artifact(
        "serial-workbench-cli",
        resolve("/another-output/serial-workbench-cli.exe"),
      ),
    ],
  ]) {
    const fixture = runner({ lines });
    await assert.rejects(
      runDev(root, [], fixture),
      /Cargo.*executables|Cargo.*output directory/,
    );
    assert.equal(fixture.calls.length, 1);
  }
});

test("dev retains Cargo rendered diagnostics while consuming JSON artifacts", async (t) => {
  const written = [];
  t.mock.method(process.stderr, "write", (message) => {
    written.push(message);
    return true;
  });
  const fixture = runner({
    lines: [
      JSON.stringify({
        reason: "compiler-message",
        message: { rendered: "error: build diagnostic\n" },
      }),
      ...artifacts,
    ],
    buildCode: 1,
  });
  assert.equal(await runDev(root, [], fixture), 1);
  assert.deepEqual(written, ["error: build diagnostic\n"]);
  assert.equal(fixture.calls.length, 1);
});
