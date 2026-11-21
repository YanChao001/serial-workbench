import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildE2E, readE2EBuildReceipt, root } from "./build.mjs";
import {
  waitForSuiteHost,
  waitForSuiteHostExit,
  serveSuiteHostRestarts,
} from "./suite-host.mjs";
import { Resvg } from "@resvg/resvg-js";
import { parseE2EOptions } from "./run-options.mjs";
import { checkNativeRequestDiagnostics } from "./native-log-evidence.mjs";
import {
  prepareSignedReferenceEvidence,
  prepareTerminalEvidence,
  readSignedReferenceFixture,
} from "./terminal-manual.mjs";
import {
  spawnOwned,
  stopOwned,
  waitForWebDriver,
  waitOwned,
} from "./process.mjs";

const require = createRequire(import.meta.url);
const owned = [];
let dataRoot;
let preserveData = false;
let artifacts = join(root, "artifacts", "e2e");
let suiteHost;
let suiteCli;
let suiteEnv;
let suiteHostBinary;
let suiteControl;
let lanCaller;
let lanCallerEnv;
let hostRun = 0;
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(new Error("桌面测试已中断"));
async function hostCommand(
  args,
  name,
  signal = AbortSignal.timeout(15000),
  env = suiteEnv,
) {
  const command = spawnOwned(
    suiteCli,
    [...args, "--profile", env.SWB_PROFILE, "--json"],
    {
      cwd: root,
      env,
      logPath: join(artifacts, `${name}-${hostRun}.log`),
    },
  );
  owned.push(command);
  await waitOwned(command, signal);
  await stopOwned(command);
}
async function startSuiteHost(retiredPid) {
  suiteHost = spawnOwned(suiteHostBinary, ["--profile", suiteEnv.SWB_PROFILE], {
    cwd: root,
    env: suiteEnv,
    logPath: join(artifacts, `host-${hostRun}.log`),
  });
  owned.push(suiteHost);
  await waitForSuiteHost(
    suiteHost,
    suiteEnv.SWB_PROFILE,
    cancellation.signal,
    retiredPid,
  );
  await hostCommand(
    ["catalog"],
    "host-ready",
    AbortSignal.any([cancellation.signal, AbortSignal.timeout(15000)]),
  );
}
async function stopSuiteHost(host = suiteHost, env = suiteEnv, name = "host") {
  await waitForSuiteHost(host, env.SWB_PROFILE, AbortSignal.timeout(2000));
  await hostCommand(["host", "stop"], `${name}-stop`, undefined, env);
  await waitForSuiteHostExit(host);
}
try {
  const { skipBuild, withNodeRuntime, phases } = parseE2EOptions(
    process.argv.slice(2),
  );
  const manual = phases.includes("terminal-manual");
  const automated = phases.includes("terminal-automated");
  const chart = phases.includes("chart-automated");
  const browserTakeover = phases.includes("browser-takeover");
  const lan = phases.includes("lan-owner");
  const nativePickers = process.env.SWB_E2E_WINDOWS_NATIVE_PICKERS === "1";
  if (
    nativePickers &&
    (!automated ||
      process.platform !== "win32" ||
      process.env.GITHUB_ACTIONS !== "true")
  ) {
    throw new Error(
      "Native file dialog automation requires the independent Windows CI terminal scenario.",
    );
  }
  const picker = process.env.SWB_E2E_WINDOWS_PICKER_BIN;
  if (
    nativePickers &&
    (!picker || !isAbsolute(picker) || !existsSync(picker))
  ) {
    throw new Error(
      "Missing the compiled Windows picker helper from this run.",
    );
  }
  const terminalFixture =
    manual || automated
      ? readSignedReferenceFixture(
          process.env.SWB_TEST_SIGNED_TERMINAL_RECEIPT,
          "terminal",
        )
      : null;
  const chartFixture = chart
    ? readSignedReferenceFixture(
        process.env.SWB_TEST_SIGNED_CHART_RECEIPT,
        "chart",
      )
    : null;
  if (!skipBuild) await buildE2E({ withNodeRuntime });
  const receipt = readE2EBuildReceipt(root, { withNodeRuntime });
  const binary = receipt.executable;
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const temporaryBase = realpathSync(tmpdir());
  dataRoot = mkdtempSync(join(temporaryBase, "starter-e2e-"));
  const profile = join(dataRoot, "host-profile");
  suiteEnv = {
    ...process.env,
    SWB_PROFILE: profile,
    STARTER_TEST_DATA_DIR: dataRoot,
    STARTER_E2E_BINARY: binary,
    STARTER_E2E_DATA_ROOT: dataRoot,
  };
  writeFileSync(
    join(dataRoot, "e2e-background.png"),
    new Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1000"><defs><linearGradient id="a"><stop stop-color="#476d98"/><stop offset="1" stop-color="#c6d9bf"/></linearGradient></defs><path fill="url(#a)" d="M0 0h1800v1000H0z"/></svg>',
    )
      .render()
      .asPng(),
  );
  mkdirSync(artifacts, { recursive: true });
  let terminal;
  if (terminalFixture) {
    artifacts = mkdtempSync(join(artifacts, "signed-terminal-"));
    terminal = prepareTerminalEvidence(terminalFixture, artifacts);
    console.log(`Signed terminal inputs: ${terminal.path}`);
  }
  if (chartFixture) {
    artifacts = mkdtempSync(join(artifacts, "signed-chart-"));
    const inputs = prepareSignedReferenceEvidence(
      chartFixture,
      artifacts,
      "chart",
    );
    writeFileSync(
      join(artifacts, "chart-inputs.json"),
      JSON.stringify(inputs, null, 2),
      { flag: "wx" },
    );
  }
  if (browserTakeover)
    artifacts = mkdtempSync(join(artifacts, "browser-takeover-"));
  if (lan) artifacts = mkdtempSync(join(artifacts, "lan-desktop-"));
  writeFileSync(
    join(artifacts, "candidate.json"),
    JSON.stringify(receipt, null, 2),
  );
  const component = (name) =>
    receipt.components.find((item) => item.name === name).path;
  suiteCli = component("serial-workbench-cli");
  suiteHostBinary = component("serial-workbench-host");
  await startSuiteHost();
  if (lan) {
    const callerRoot = join(dataRoot, "caller-desktop");
    lanCallerEnv = {
      ...suiteEnv,
      SWB_PROFILE: join(callerRoot, "host-profile"),
      STARTER_TEST_DATA_DIR: callerRoot,
      STARTER_E2E_DATA_ROOT: callerRoot,
    };
    lanCaller = spawnOwned(
      suiteHostBinary,
      ["--profile", lanCallerEnv.SWB_PROFILE],
      {
        cwd: root,
        env: lanCallerEnv,
        logPath: join(artifacts, "caller-host.log"),
      },
    );
    owned.push(lanCaller);
    await waitForSuiteHost(
      lanCaller,
      lanCallerEnv.SWB_PROFILE,
      cancellation.signal,
    );
    await hostCommand(
      ["catalog"],
      "caller-host-ready",
      AbortSignal.any([cancellation.signal, AbortSignal.timeout(15000)]),
      lanCallerEnv,
    );
  }
  const hostDiscovery = () =>
    JSON.parse(
      readFileSync(join(profile, "host-v0", "discovery.json"), "utf8"),
    );
  const hostEvidence = join(
    artifacts,
    terminal ? "terminal-host.json" : "host.json",
  );
  if (terminal || chart) {
    const { hostId, instanceEpoch, pid } = hostDiscovery();
    writeFileSync(
      hostEvidence,
      JSON.stringify({ hostId, instanceEpoch, pid }, null, 2),
      { flag: "wx" },
    );
  }
  if (!terminal && !lan)
    suiteControl = serveSuiteHostRestarts(dataRoot, async () => {
      const previous = suiteHost;
      await stopSuiteHost();
      await stopOwned(previous);
      hostRun++;
      await startSuiteHost(previous.child.pid);
      const { hostId, instanceEpoch, pid } = hostDiscovery();
      const evidence = {
        hostId,
        instanceEpoch,
        pid,
        previousPid: previous.child.pid,
      };
      writeFileSync(
        join(artifacts, `host-restart-${hostRun}.json`),
        JSON.stringify(evidence, null, 2),
      );
      return evidence;
    });
  // 测试部署显式关闭真实更新源，避免启动检查访问生产 GitHub。
  for (const desktopRoot of [
    dataRoot,
    lanCallerEnv?.STARTER_TEST_DATA_DIR,
  ].filter(Boolean)) {
    mkdirSync(join(desktopRoot, "config"));
    writeFileSync(
      join(desktopRoot, "config", "deployment.json"),
      JSON.stringify({ updates: { endpoint: "", publicKey: "" } }),
    );
  }
  for (const phase of phases) {
    await waitForSuiteHost(suiteHost, profile, cancellation.signal);
    if (lan) {
      await waitForSuiteHost(
        lanCaller,
        lanCallerEnv.SWB_PROFILE,
        cancellation.signal,
      );
    }
    const port = await new Promise((done, fail) => {
      const socket = createServer();
      socket.once("error", fail);
      socket.listen(0, "127.0.0.1", () => {
        const port = socket.address().port;
        socket.close((error) => (error ? fail(error) : done(port)));
      });
    });
    const env = {
      ...(phase === "lan-caller" ? lanCallerEnv : suiteEnv),
      // 普通 EOF 属于调试信息；独立验收仍保留其时刻，不提升生产告警级别。
      SWB_LOG_LEVEL: "debug",
      TAURI_WEBDRIVER_PORT: String(port),
      STARTER_E2E_BINARY: binary,
      STARTER_E2E_PHASE: phase,
      STARTER_E2E_PORT: String(port),
    };
    const phaseArtifacts = join(artifacts, phase);
    if (automated) {
      env.STARTER_E2E_TERMINAL_DIR = artifacts;
      env.STARTER_E2E_TERMINAL_CLI = suiteCli;
    }
    if (chart) env.STARTER_E2E_CHART_DIR = artifacts;
    if (browserTakeover || lan) {
      env.STARTER_E2E_CLI = suiteCli;
      env.STARTER_E2E_MCP = component("serial-workbench-mcp");
      env.SWB_DEV_EXPECTED_HOST_EXECUTABLE = suiteHostBinary;
    }
    if (browserTakeover) env.STARTER_E2E_BROWSER_DIR = artifacts;
    if (lan) {
      env.STARTER_E2E_LAN_DIR = artifacts;
      env.STARTER_E2E_LAN_HANDOFF = join(dataRoot, "lan-handoff.json");
      env.STARTER_E2E_LAN_OWNER_PROFILE = profile;
      env.STARTER_E2E_LAN_CALLER_PROFILE = lanCallerEnv.SWB_PROFILE;
    }
    const app = spawnOwned(binary, [], {
      cwd: root,
      env,
      logPath: join(phaseArtifacts, "native.log"),
      windowsJobReceipt:
        process.platform === "win32"
          ? join(dataRoot, `windows-job-owner-${phase}.txt`)
          : undefined,
    });
    owned.push(app);
    if (nativePickers) env.STARTER_E2E_APP_PID = String(app.child.pid);
    let runner;
    try {
      await waitForWebDriver(app, port, cancellation.signal);
      if (manual) {
        console.log(
          `Use the actual file dialogs. Quit the application after completing the scenario. Capture: ${terminal.capture}`,
        );
        await waitOwned(app, cancellation.signal);
      } else {
        runner = spawnOwned(
          process.execPath,
          [
            join(
              dirname(dirname(require.resolve("@wdio/cli"))),
              "bin",
              "wdio.js",
            ),
            "run",
            "wdio.conf.mjs",
          ],
          {
            cwd: root,
            env,
            ...(automated || chart || browserTakeover || lan
              ? { logPath: join(phaseArtifacts, "webdriver.log") }
              : {}),
          },
        );
        owned.push(runner);
        const deadline = AbortSignal.timeout(10 * 60 * 1000);
        try {
          await waitOwned(
            runner,
            AbortSignal.any([cancellation.signal, deadline]),
          );
        } catch (error) {
          if (app.child.exitCode !== null || app.child.signalCode !== null)
            throw new Error(
              `测试应用提前退出（code=${app.child.exitCode ?? "null"} signal=${app.child.signalCode ?? "null"}）；${error.message}`,
              { cause: error },
            );
          throw error;
        }
      }
    } finally {
      await stopOwned(runner);
      await stopOwned(app);
    }
    checkNativeRequestDiagnostics(
      join(phaseArtifacts, "native.log"),
      join(phaseArtifacts, "rpc-request-conflicts.json"),
    );
  }
  if (lan) {
    await stopSuiteHost(lanCaller, lanCallerEnv, "caller-host");
    await stopSuiteHost();
    writeFileSync(
      join(artifacts, "host-exit.json"),
      JSON.stringify({
        caller: lanCaller.child.pid,
        owner: suiteHost.child.pid,
      }) + "\n",
    );
  }
  if (terminal) {
    await stopSuiteHost();
    const verifier = receipt.referenceTools.find(
      ({ name }) => name === "terminal_capture_check",
    );
    const check = spawnOwned(
      verifier.path,
      [terminal.capture, terminal.expected, hostEvidence],
      {
        cwd: root,
        logPath: join(artifacts, "capture-verifier.log"),
      },
    );
    owned.push(check);
    await waitOwned(
      check,
      AbortSignal.any([
        cancellation.signal,
        AbortSignal.timeout(10 * 60 * 1000),
      ]),
    );
    await stopOwned(check);
    console.log(
      `Recorded RX verified. File selection, focus and view observations belong in: ${artifacts}`,
    );
  }
} catch (error) {
  preserveData = true;
  console.error(error.message);
  process.exitCode = cancellation.signal.aborted ? 130 : 1;
} finally {
  try {
    await suiteControl?.close();
  } catch (error) {
    preserveData = true;
    process.exitCode = 1;
    console.error(error.message);
  }
  for (const [host, env, name] of [
    [lanCaller, lanCallerEnv, "caller-host"],
    [suiteHost, suiteEnv, "host"],
  ]) {
    if (!host || host.state.done) continue;
    try {
      await stopSuiteHost(host, env, name);
    } catch (error) {
      preserveData = true;
      process.exitCode = 1;
      console.error(`Owned ${name} shutdown failed: ${error.message}`);
    }
  }
  for (const processHandle of owned.reverse()) {
    try {
      await stopOwned(processHandle);
    } catch (error) {
      preserveData = true;
      console.error(error.message);
      process.exitCode = 1;
    }
  }
  if (dataRoot && !preserveData) {
    const temporaryBase = realpathSync(tmpdir());
    const resolved = resolve(dataRoot);
    if (
      dirname(resolved) !== temporaryBase ||
      !resolved.startsWith(join(temporaryBase, "starter-e2e-"))
    ) {
      console.error("拒绝清理非本次创建的测试目录");
      process.exitCode = 1;
    } else {
      try {
        rmSync(resolved, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 300,
        });
      } catch (error) {
        console.warn(
          `测试数据清理失败，目录保留：${dataRoot}（${error.message}）`,
        );
      }
    }
  }
  if (dataRoot && preserveData)
    console.error(`E2E evidence preserved at ${dataRoot}`);
  // 合作取消覆盖实际资源清理，迟到的信号不能终止仍在回收子进程的负责人。
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
