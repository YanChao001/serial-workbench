import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseE2EOptions } from "./run-options.mjs";

test("desktop runs require an explicit foreground choice, including reused builds", () => {
  for (const args of [
    [],
    ["--skip-build"],
    ["--with-node-runtime"],
    ["--terminal-manual"],
    ["--terminal-automated"],
  ])
    assert.throws(() => parseE2EOptions(args), /默认不启动/);
  const phases = ["fresh", "persisted", "centered"];
  assert.deepEqual(parseE2EOptions(["--interactive"]), {
    skipBuild: false,
    withNodeRuntime: false,
    phases,
  });
  assert.deepEqual(parseE2EOptions(["--interactive", "--skip-build"]), {
    skipBuild: true,
    withNodeRuntime: false,
    phases,
  });
  assert.deepEqual(parseE2EOptions(["--skip-build", "--interactive"]), {
    skipBuild: true,
    withNodeRuntime: false,
    phases,
  });
  assert.deepEqual(
    parseE2EOptions(["--interactive", "--skip-build", "--with-node-runtime"]),
    { skipBuild: true, withNodeRuntime: true, phases },
  );
  assert.deepEqual(parseE2EOptions(["--interactive", "--terminal-manual"]), {
    skipBuild: false,
    withNodeRuntime: true,
    phases: ["terminal-manual"],
  });
  assert.deepEqual(
    parseE2EOptions(["--interactive", "--skip-build", "--terminal-automated"]),
    { skipBuild: true, withNodeRuntime: true, phases: ["terminal-automated"] },
  );
});

test("invalid foreground flags fail without enabling the desktop runner", () => {
  for (const args of [
    ["--interactive=false"],
    ["--interactive", "--headless"],
    ["--interactive", "--previews"],
  ])
    assert.throws(() => parseE2EOptions(args), /Usage/);
  assert.throws(
    () =>
      parseE2EOptions([
        "--interactive",
        "--terminal-manual",
        "--terminal-automated",
      ]),
    /Usage/,
  );
});

for (const args of [
  [],
  ["--skip-build"],
  ["--terminal-manual"],
  ["--terminal-automated"],
]) {
  test(`the CLI refuses ${args.join(" ") || "a default run"} before build lookup or launch`, () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./run.mjs", import.meta.url)), ...args],
      {
        // 没有工具链且设置 CI，仍必须先返回前台运行提示，不能开始构建或读取收据。
        env: { ...process.env, PATH: "", Path: "", CI: "1" },
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /默认不启动/);
    assert.match(result.stderr, /pnpm test:ui/);
    assert.equal(result.stdout, "");
  });
}

for (const mode of ["--terminal-manual", "--terminal-automated"]) {
  test(`native terminal run ${mode} requires its signed input before build or launch`, () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./run.mjs", import.meta.url)),
        "--interactive",
        mode,
      ],
      {
        env: {
          ...process.env,
          SWB_TEST_SIGNED_TERMINAL_RECEIPT: "relative.json",
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /absolute signed terminal receipt path/);
    assert.equal(result.stdout, "");
  });
}

test("ordinary script checks skip native installer executables before probing tools, including CI", () => {
  const env = {
    ...process.env,
    PATH: "",
    Path: "",
    LOCALAPPDATA: "",
    CI: "1",
  };
  // 子 CLI 独立输出 TAP，不继承父测试 runner 的内部二进制报告协议。
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      fileURLToPath(
        new URL("../scripts/installer-layout.test.mjs", import.meta.url),
      ),
    ],
    {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /SKIP Native installer executable tests require pnpm test:installer --interactive/,
  );
});
