import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { removeProjectPath } from "./fs-utils.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (name) => readFileSync(resolve(root, name), "utf8");
const ci = read(".github/workflows/ci.yml");
const native = read(".github/workflows/native-e2e.yml");
const job = (name, source = ci) => {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, name);
  return source.slice(start + 1).split(/\n {2}[\w-]+:\n/)[0];
};

// These assertions lock repository policy; actionlint and an actual manual run
// validate GitHub syntax, runner availability and the commands themselves.
test("CI and audit run only on manual dispatch and use read-only repository permission", () => {
  for (const name of ["ci", "audit"]) {
    const content = read(`.github/workflows/${name}.yml`);
    const triggers = content.split(/^on:\s*$/m)[1]?.split(/^\S/m)[0];
    assert.ok(triggers, name);
    assert.deepEqual(
      [...triggers.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]),
      ["workflow_dispatch"],
    );
    assert.match(content, /^permissions:\n {2}contents: read\n/m);
    assert.doesNotMatch(
      content,
      /contents: write|pull_request_target|publish-release/,
    );
  }
  assert.match(ci, /desktop_e2e:[\s\S]*?type: boolean\n {8}default: true/);
  assert.match(
    job("desktop-e2e"),
    /^ {4}if: inputs\.desktop_e2e && !inputs\.native_preflight && !inputs\.runtime_preflight$/m,
  );
});

test("both native matrices cover all four targets without scope or tree reuse", () => {
  const expected = [
    ["windows-2022", "x86_64-pc-windows-msvc"],
    ["ubuntu-22.04", "x86_64-unknown-linux-gnu"],
    ["macos-15", "aarch64-apple-darwin"],
    ["macos-15-intel", "x86_64-apple-darwin"],
  ];
  for (const name of ["rust", "desktop-e2e"]) {
    const body = job(name);
    assert.match(body, /fail-fast: false/);
    assert.deepEqual(
      [...body.matchAll(/- platform: ([\w.-]+)\n {12}target: ([\w-]+)/g)].map(
        (m) => [m[1], m[2]],
      ),
      expected,
    );
    const runner = name === "desktop-e2e" ? native : body;
    assert.match(runner, /MACOSX_DEPLOYMENT_TARGET: "14\.0"/);
    assert.match(
      runner,
      new RegExp(
        `bash scripts/ci-linux-deps\\.sh ${name === "desktop-e2e" ? "native" : "rust"}`,
      ),
    );
    assert.match(
      runner,
      /key: (?:native|e2e)-\$\{\{ (?:matrix|inputs)\.target \}\}/,
    );
  }
  assert.doesNotMatch(ci, /docs_only|rust_required|reused_run|needs: changes/);
  for (const name of [
    "frontend",
    "browser-smoke",
    "linux-node-backend",
    "bindings",
  ]) {
    assert.match(
      job(name),
      /^ {4}if: \$\{\{ !inputs\.native_preflight && !inputs\.runtime_preflight \}\}$/m,
      name,
    );
  }
  assert.match(job("rust"), /cargo clippy --locked --workspace --all-targets/);
  assert.match(job("rust"), /cargo test --locked --workspace --no-fail-fast/);
  assert.match(job("rust"), /pnpm app:build --no-bundle --target/);
  assert.match(job("bindings"), /pnpm bindings:check/);
});

test("preflight shares the full native runner and retains successful source receipts", () => {
  for (const name of ["desktop-e2e", "native-preflight"])
    assert.match(job(name), /uses: \.\/.github\/workflows\/native-e2e.yml/);
  const preflight = job("native-preflight");
  const runnerMap = preflight.match(/platform: \$\{\{ fromJSON\('([^']+)'\)/);
  assert.ok(runnerMap, "preflight runners must come from a fixed whitelist");
  assert.deepEqual(JSON.parse(runnerMap[1]), {
    "x86_64-unknown-linux-gnu": "ubuntu-22.04",
    "x86_64-pc-windows-msvc": "windows-2022",
    "aarch64-apple-darwin": "macos-15",
    "x86_64-apple-darwin": "macos-15-intel",
  });
  const targetInput = ci.match(
    / {6}native_preflight_target:\n([\s\S]*?)(?=\n {6}\w|\n\S)/,
  )?.[1];
  assert.ok(targetInput);
  assert.match(targetInput, /type: choice/);
  assert.match(targetInput, /default: x86_64-unknown-linux-gnu/);
  assert.deepEqual(
    [...targetInput.matchAll(/^ {10}- ([\w-]+)$/gm)].map((match) => match[1]),
    Object.keys(JSON.parse(runnerMap[1])),
  );
  assert.match(
    preflight,
    /\)\[inputs\.native_preflight_target \|\| 'x86_64-unknown-linux-gnu'\] \}\}/,
  );
  assert.match(
    preflight,
    /target: \$\{\{ inputs\.native_preflight_target \|\| 'x86_64-unknown-linux-gnu' \}\}/,
  );
  assert.match(
    preflight,
    /native_file_dialogs: \$\{\{ inputs\.native_preflight_target == 'x86_64-pc-windows-msvc' \}\}/,
  );
  assert.match(
    job("desktop-e2e"),
    /native_file_dialogs: \$\{\{ matrix\.target == 'x86_64-pc-windows-msvc' \}\}/,
  );
  assert.match(
    native,
    /if: runner\.os != 'Linux' && !inputs\.chart_only && !\(runner\.os == 'Windows' && inputs\.native_file_dialogs\)\n\s+run: pnpm test:e2e --interactive --skip-build --terminal-automated/,
  );
  assert.match(
    native,
    /if: runner\.os == 'Windows' && inputs\.native_file_dialogs && !inputs\.chart_only\n\s+env:\n\s+SWB_E2E_WINDOWS_NATIVE_PICKERS: "1"\n\s+run: pnpm test:e2e --interactive --skip-build --terminal-automated/,
  );
  const triggers = native.split(/^on:\s*$/m)[1]?.split(/^\S/m)[0];
  assert.deepEqual(
    [...triggers.matchAll(/^ {2}([\w-]+):/gm)].map((match) => match[1]),
    ["workflow_call"],
  );
  assert.match(native, /runs-on: \$\{\{ inputs\.platform \}\}/);
  assert.match(native, /保留原生收据、截图与测试日志\n {8}if: always\(\)/);
  assert.match(
    native,
    /if: runner\.os != 'Linux' && !inputs\.chart_only && !\(runner\.os == 'Windows' && inputs\.windows_reference_only\)\n\s+run: pnpm test:e2e --interactive --skip-build$/m,
  );
  assert.match(
    ci,
    /windows_reference_only: \$\{\{ inputs\.native_preflight_target == 'x86_64-pc-windows-msvc' && !inputs\.desktop_e2e \}\}/,
  );
  assert.match(
    preflight,
    /chart_only: \$\{\{ inputs\.native_preflight_chart \}\}/,
  );
  assert.match(
    native,
    /if: runner\.os != 'Linux' && \(inputs\.chart_only \|\| inputs\.chart_with_desktop\)\n\s+env:\n\s+SWB_E2E_WINDOWS_NATIVE_PICKERS: .*inputs\.native_file_dialogs.*\n\s+run: pnpm test:e2e --interactive --skip-build --chart-automated/,
  );
  assert.match(
    job("desktop-e2e"),
    /chart_with_desktop: \$\{\{ inputs\.desktop_chart && matrix\.target == 'x86_64-pc-windows-msvc' \}\}/,
  );
  assert.match(
    native,
    /REFERENCES: .*inputs\.chart_with_desktop && 'terminal chart'/,
  );
  assert.match(
    job("quality-gate"),
    /name: \$\{\{ inputs\.native_preflight && '原生预检结果（非里程碑验收）' \|\| '质量门禁' \}\}/,
  );
  assert.match(
    job("quality-gate"),
    /确认所有检查通过\n {8}if: \$\{\{ !inputs\.native_preflight \}\}/,
  );
  assert.match(job("quality-gate"), /NATIVE_PREFLIGHT_RESULT !== 'success'/);
});

test("the gate always gathers every job, and all jobs have a time budget", () => {
  assert.match(
    job("quality-gate"),
    /if: always\(\) && !inputs\.runtime_preflight/,
  );
  assert.match(
    job("quality-gate"),
    /needs:\s*\[\s*frontend,\s*browser-smoke,\s*rust,\s*linux-node-backend,\s*bindings,\s*desktop-e2e,\s*native-preflight,?\s*\]/,
  );
  assert.match(
    job("quality-gate"),
    /CI_DESKTOP_E2E: \$\{\{ inputs\.desktop_e2e \}\}/,
  );
  for (const [, name] of ci.matchAll(/^ {2}([\w-]+):\n/g)) {
    if (name === "workflow_dispatch") continue;
    const runner =
      name === "runtime-preflight"
        ? read(".github/workflows/runtime-preflight.yml")
        : ["desktop-e2e", "native-preflight"].includes(name)
          ? job("desktop-e2e", native)
          : job(name);
    assert.match(runner, /timeout-minutes: \d+/, name);
  }
});

test("Windows gates real Chromium file transfer and experiment exchange with runner-local evidence", () => {
  const rust = job("rust");
  const step = rust
    .split("id: paired-workbench-files\n")[1]
    ?.split("\n      - name:")[0];
  assert.ok(step);
  assert.match(step, /if: runner\.os == 'Windows'/);
  assert.match(step, /pnpm build:web/);
  assert.match(step, /process\.env\.RUNNER_TEMP/);
  assert.match(
    step,
    /SWB_TEST_BROWSER_TRANSFER_OUTPUT=.*\n\s+if ! cargo test .*--test browser_pairing \\\n\s+browser_file_upload_sends_the_selected_range_once_and_returns_quota_after_revocation/,
  );
  assert.match(
    step,
    /SWB_TEST_EXPERIMENT_BROWSER_OUTPUT=.*\n\s+if ! cargo test .*--test capture_api_host \\\n\s+paired_browsers_exchange_experiment_between_two_hosts \\\n\s+-- --ignored/,
  );
  assert.doesNotMatch(rust, /artifacts\/paired-workbench/);
});

test("Linux verified backend checks are required and use an independent fixed runtime", () => {
  const backend = job("linux-node-backend");
  assert.match(backend, /runs-on: ubuntu-22\.04/);
  assert.match(backend, /timeout-minutes: 60/);
  assert.match(backend, /RUNTIME_TARGET: x86_64-unknown-linux-gnu/);
  assert.match(backend, /node scripts\/ci-prepare-node-runtime\.mjs/);
  assert.match(backend, /actions\/cache\/restore@[a-f0-9]{40}/);
  assert.match(backend, /key: swb-linux-runtime-sources-\$\{\{ hashFiles\(/);
  assert.doesNotMatch(backend, /restore-keys:|sources\/\*\*|payload\.partial/);
  assert.match(
    backend,
    /run: node scripts\/ci-prepare-node-runtime\.mjs\n\s+- name: 交付本次验签的 Ubuntu 固定源码\n[\s\S]*?actions\/upload-artifact@[a-f0-9]{40}/,
  );
  assert.match(
    backend,
    /source-artifact-id: \$\{\{ steps\.linux-source-artifact\.outputs\.artifact-id \}\}/,
  );
  const rust = job("rust");
  assert.match(
    rust,
    /needs: linux-node-backend\n {4}if: \$\{\{ !cancelled\(\) && !inputs\.native_preflight && !inputs\.runtime_preflight \}\}/,
  );
  assert.match(rust, /actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(
    rust,
    /artifact-ids: \$\{\{ needs\.linux-node-backend\.outputs\.source-artifact-id \}\}\n\s+path: \.cache\/node-runtime\/sources/,
  );
  assert.match(rust, /\^\[0-9\]\+\$/);
  assert.doesNotMatch(rust, /actions\/cache\/restore@/);
  assert.match(
    backend,
    /- name: 保存验签通过的 Ubuntu 固定源码\n[\s\S]*?actions\/cache\/save@[a-f0-9]{40}/,
  );
  const suite =
    "cargo test --locked -p serial-workbench-host --test node_packages verified_backend_ -- --ignored --test-threads=1 --nocapture";
  assert.ok(backend.includes(suite));
  assert.match(
    job("rust"),
    /if \[\[ "\$RUNNER_OS" != "Linux" \]\]; then\n\s+cargo test --locked -p serial-workbench-host --test node_packages verified_backend_/,
  );
  assert.ok(job("rust").includes("--duration-seconds 600"));
  assert.doesNotMatch(
    backend,
    /pnpm app:build|pnpm test:e2e|ci-linux-deps\.sh/,
  );
  assert.match(backend, /shell: bash/);
  assert.match(backend, /if: always\(\)/);
});

test("runtime diagnostics stay separate from the milestone gate and isolate desktop update", () => {
  const runtime = read(".github/workflows/runtime-preflight.yml");
  assert.match(job("runtime-preflight"), /if: inputs\.runtime_preflight/);
  assert.match(
    job("runtime-preflight"),
    /uses: \.\/.github\/workflows\/runtime-preflight\.yml/,
  );
  assert.match(
    job("native-preflight"),
    /if: inputs\.native_preflight && !inputs\.runtime_preflight/,
  );
  assert.match(runtime, /workflow_call:/);
  assert.doesNotMatch(
    runtime,
    /workflow_dispatch:|pnpm test:e2e|contents: write/,
  );
  const nsisStage = runtime.match(
    /- name: 编译未签名的 NSIS 并在隔离 runner 验证暂存夹具\n[\s\S]*?(?= {6}- name:)/,
  )?.[0];
  assert.ok(nsisStage);
  assert.doesNotMatch(runtime.replace(nsisStage, ""), /pnpm app:build/);
  assert.match(nsisStage, /if: inputs\.suite == 'windows-nsis-stage'/);
  assert.match(nsisStage, /pnpm app:build .*--bundles nsis/);
  assert.match(nsisStage, /SWB_TEST_NSIS_STAGE_INSTALLER/);
  assert.match(nsisStage, /--features bindings --bin verify-updater/);
  assert.match(nsisStage, /SWB_TEST_NSIS_STAGE_VERIFIER/);
  assert.match(nsisStage, /windows-nsis-switch/);
  assert.match(nsisStage, /pnpm version:set \$nextVersion/);
  assert.match(nsisStage, /pnpm test:installer --interactive/);
  assert.ok(
    runtime.includes("artifacts/windows-nsis-stage/installer-layout.log"),
  );
  assert.match(
    runtime,
    /if: inputs\.suite == 'windows-nsis-desktop-update'\s+shell: pwsh\s+run: \.\/scripts\/ci-windows-desktop-update\.ps1 -Target \$env:RUNTIME_TARGET/,
  );
  assert.match(
    runtime,
    /if: inputs\.suite == 'windows-nsis-wire-v1'\s+shell: pwsh\s+run: \.\/scripts\/ci-windows-desktop-update\.ps1 -Target \$env:RUNTIME_TARGET -PreviousCommit ffff1fec81f7762ea20450d075ab1c373bf6f249/,
  );
  assert.ok(runtime.includes("artifacts/windows-desktop-update/receipt.json"));
  assert.match(
    runtime,
    /cargo build --locked -p serial-workbench-host -p serial-workbench-cli -p serial-workbench-mcp\s+--example node_runtime_probe --bin serial-workbench-cli --bin serial-workbench-mcp/,
  );
  assert.match(
    runtime,
    /cargo test --locked -p serial-workbench-host --test node_runtime -- --include-ignored --test-threads=1/,
  );
  for (const workflow of [ci, runtime]) {
    assert.match(
      workflow,
      /cargo test --locked -p serial-workbench-host --test node_packages verified_backend_ -- --ignored --test-threads=1/,
    );
    assert.match(
      workflow,
      /cargo test --locked -p serial-workbench-host --lib native_node_ -- --ignored --test-threads=1 --nocapture/,
    );
    assert.match(
      workflow,
      /export SWB_TEST_CLI_BIN="\$PWD\/src-tauri\/target\/debug\/serial-workbench-cli\$suffix"/,
    );
    assert.match(
      workflow,
      /export SWB_TEST_MCP_BIN="\$PWD\/src-tauri\/target\/debug\/serial-workbench-mcp\$suffix"/,
    );
    assert.match(
      workflow,
      /export SWB_TEST_CLI_BIN=.*\n\s+export SWB_TEST_MCP_BIN=.*\n\s+cargo test --locked -p serial-workbench-host --lib native_node_/,
    );
    assert.match(workflow, /pnpm plugin-sdk:fixture/);
    assert.match(
      workflow,
      /export SWB_TEST_NODE_SDK_FIXTURE="\$PWD\/\.cache\/plugin-sdk\/examples\/native-parity\.js"/,
    );
    assert.match(
      workflow,
      /cargo test --locked -p serial-workbench-host --test client_parity native_node_dynamic_ -- --ignored --test-threads=1 --nocapture/,
    );
    assert.match(
      workflow,
      /if \[\[ "\$RUNNER_OS" == "macOS" \]\]; then cargo test --locked -p serial-workbench-host --lib native_macos_ -- --ignored --test-threads=1; fi/,
    );
    for (const prefix of [
      "node-backend-",
      "host-node-backend-",
      "macos-node-before-auth-",
    ]) {
      assert.ok(workflow.includes(`artifacts/rust-failures/${prefix}*/**`));
    }
    assert.ok(
      workflow.includes(
        "artifacts/rust-failures/host-node-task-derived-*/derived.events",
      ),
    );
  }
  assert.match(
    job("rust"),
    /cargo build --locked -p serial-workbench-host \\\n\s+--example node_runtime_probe --example sign_reference_terminal \\\n\s+--example sign_reference_chart --example sign_reference_automation/,
  );
  assert.equal(
    (job("rust").match(/--example sign_reference_terminal/g) ?? []).length,
    1,
  );
  assert.match(
    ci,
    /cargo test --locked -p serial-workbench --lib native_reference_terminal_ -- --ignored --test-threads=1 --nocapture/,
  );
  assert.ok(
    ci.includes(
      'SWB_TEST_TERMINAL_HOST_BIN="$installed/serial-workbench-host$suffix"',
    ),
  );
  assert.ok(ci.includes("artifacts/reference-terminal/signed-terminal.json"));
  assert.ok(ci.includes("artifacts/reference-terminal/native-reader.log"));
  for (const [name, testName, log] of [
    [
      "chart",
      "native_chart_samples_exact_rx_from_the_signed_reference_package",
      "native-samples",
    ],
    [
      "automation",
      "native_automation_uses_exact_responses_and_keeps_capture_running",
      "native-response",
    ],
    [
      "automation",
      "native_automation_long_script_survives_caller_disconnect_and_settles_workers",
      "native-long-script",
    ],
  ]) {
    assert.ok(
      ci.includes(
        `cargo test --locked -p serial-workbench --lib ${testName} -- --ignored --test-threads=1 --nocapture`,
      ),
    );
    assert.ok(ci.includes(`artifacts/reference-${name}/signed-${name}.json`));
    assert.ok(ci.includes(`artifacts/reference-${name}/${log}.log`));
  }
  assert.match(runtime, /name: runtime-preflight-\$\{\{ matrix\.target \}\}/);
  assert.match(runtime, /fail-fast: false/);
  for (const [step, suite] of [
    ["验证原生 runtime 安装布局与故障", "all"],
    ["定向验证 Host 管道和自动恢复", "host-ipc"],
    ["定向验证 macOS 进程签名", "macos-signature"],
    ["验证 Debian 实际离线安装与参考包", "linux-offline-installer"],
    ["验证 macOS DMG 实际离线安装与参考包", "macos-offline-installer"],
  ]) {
    assert.ok(
      runtime.includes(
        `- name: ${step}\n        if: inputs.suite == '${suite}'`,
      ),
    );
  }
  assert.match(
    ci,
    /runtime_preflight:[\s\S]*?type: boolean\n {8}default: false/,
  );
});

test("runtime preflight executes a fixed four-target plan and rejects conflicting or unknown input", (t) => {
  const runtime = read(".github/workflows/runtime-preflight.yml");
  const script = runtime
    .match(/node --input-type=module <<'NODE'\n([\s\S]*?) {10}NODE/)?.[1]
    .replace(/^ {10}/gm, "");
  assert.ok(script);
  const parent = join(root, ".cache/script-tests");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "runtime-plan-"));
  t.after(() => {
    if (t.passed) removeProjectPath(root, relative(root, directory));
  });
  const run = (target, conflict = "false", suite = "all") => {
    const output = join(directory, `${target}-${conflict}-${suite}.txt`);
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      cwd: root,
      input: script,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        RUNTIME_TARGET: target,
        RUNTIME_SUITE: suite,
        CONFLICTING_PREFLIGHT: conflict,
        GITHUB_OUTPUT: output,
      },
      windowsHide: true,
    });
    return { result, output };
  };
  const all = run("all");
  assert.equal(all.result.status, 0, all.result.stderr);
  const matrix = JSON.parse(
    readFileSync(all.output, "utf8").trim().slice("matrix=".length),
  );
  assert.deepEqual(matrix.include, [
    { target: "x86_64-unknown-linux-gnu", platform: "ubuntu-22.04" },
    { target: "x86_64-pc-windows-msvc", platform: "windows-2022" },
    { target: "aarch64-apple-darwin", platform: "macos-15" },
    { target: "x86_64-apple-darwin", platform: "macos-15-intel" },
  ]);
  for (const [target, suite, platform] of [
    ["aarch64-apple-darwin", "host-ipc", "macos-15"],
    ["x86_64-apple-darwin", "macos-signature", "macos-15-intel"],
    ["x86_64-pc-windows-msvc", "windows-nsis-stage", "windows-2022"],
    ["x86_64-pc-windows-msvc", "windows-nsis-switch", "windows-2022"],
    ["x86_64-pc-windows-msvc", "windows-nsis-desktop-update", "windows-2022"],
    ["x86_64-pc-windows-msvc", "windows-nsis-wire-v1", "windows-2022"],
    ["x86_64-unknown-linux-gnu", "linux-offline-installer", "ubuntu-22.04"],
    ["aarch64-apple-darwin", "macos-offline-installer", "macos-15"],
  ]) {
    const one = run(target, "false", suite);
    assert.equal(one.result.status, 0, one.result.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(one.output, "utf8").trim().slice(7)).include,
      [{ target, platform }],
    );
  }
  for (const [target, conflict, suite, message] of [
    ["all", "true", "all", /mutually exclusive/],
    ["unknown", "false", "all", /Unsupported runtime preflight target/],
    ["all", "false", "unknown", /Unsupported runtime preflight suite/],
    ["all", "false", "host-ipc", /needs one target/],
    ["x86_64-pc-windows-msvc", "false", "macos-signature", /requires macOS/],
    [
      "x86_64-unknown-linux-gnu",
      "false",
      "windows-nsis-stage",
      /requires Windows x64/,
    ],
    [
      "aarch64-apple-darwin",
      "false",
      "windows-nsis-switch",
      /requires Windows x64/,
    ],
    [
      "aarch64-apple-darwin",
      "false",
      "windows-nsis-desktop-update",
      /requires Windows x64/,
    ],
    [
      "x86_64-apple-darwin",
      "false",
      "linux-offline-installer",
      /requires Linux x64/,
    ],
    [
      "x86_64-pc-windows-msvc",
      "false",
      "macos-offline-installer",
      /requires macOS/,
    ],
  ]) {
    const { result } = run(target, conflict, suite);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});
