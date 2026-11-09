import {
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
import { dirname, join, resolve } from "node:path";
import { buildE2E, readE2EBuildReceipt, root } from "./build.mjs";
import {
  waitForSuiteHost,
  waitForSuiteHostExit,
  serveSuiteHostRestarts,
} from "./suite-host.mjs";
import { Resvg } from "@resvg/resvg-js";
import { parseE2EOptions } from "./run-options.mjs";
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
let suiteHost;
let suiteCli;
let suiteEnv;
let suiteHostBinary;
let suiteControl;
let hostRun = 0;
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(new Error("桌面测试已中断"));
async function hostCommand(args, name, signal = AbortSignal.timeout(15000)) {
  const command = spawnOwned(
    suiteCli,
    [...args, "--profile", suiteEnv.SWB_PROFILE, "--json"],
    {
      cwd: root,
      env: suiteEnv,
      logPath: join(root, "artifacts", "e2e", `${name}-${hostRun}.log`),
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
    logPath: join(root, "artifacts", "e2e", `host-${hostRun}.log`),
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
async function stopSuiteHost() {
  await waitForSuiteHost(
    suiteHost,
    suiteEnv.SWB_PROFILE,
    AbortSignal.timeout(2000),
  );
  await hostCommand(["host", "stop"], "host-stop");
  await waitForSuiteHostExit(suiteHost);
}
try {
  const { skipBuild, phases } = parseE2EOptions(process.argv.slice(2));
  if (!skipBuild) await buildE2E();
  const receipt = readE2EBuildReceipt();
  const binary = receipt.executable;
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
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
  mkdirSync(join(root, "artifacts", "e2e"), { recursive: true });
  writeFileSync(
    join(root, "artifacts", "e2e", "candidate.json"),
    JSON.stringify(receipt, null, 2),
  );
  const component = (name) =>
    receipt.components.find((item) => item.name === name).path;
  suiteCli = component("serial-workbench-cli");
  suiteHostBinary = component("serial-workbench-host");
  await startSuiteHost();
  suiteControl = serveSuiteHostRestarts(dataRoot, async () => {
    const previous = suiteHost;
    await stopSuiteHost();
    await stopOwned(previous);
    hostRun++;
    await startSuiteHost(previous.child.pid);
    const { hostId, instanceEpoch, pid } = JSON.parse(
      readFileSync(join(profile, "host-v0", "discovery.json"), "utf8"),
    );
    const evidence = {
      hostId,
      instanceEpoch,
      pid,
      previousPid: previous.child.pid,
    };
    writeFileSync(
      join(root, "artifacts", "e2e", `host-restart-${hostRun}.json`),
      JSON.stringify(evidence, null, 2),
    );
    return evidence;
  });
  // 测试部署显式关闭真实更新源，避免启动检查访问生产 GitHub。
  mkdirSync(join(dataRoot, "config"));
  writeFileSync(
    join(dataRoot, "config", "deployment.json"),
    JSON.stringify({
      updates: { endpoint: "", publicKey: "" },
    }),
  );
  for (const phase of phases) {
    await waitForSuiteHost(suiteHost, profile, cancellation.signal);
    const port = await new Promise((done, fail) => {
      const socket = createServer();
      socket.once("error", fail);
      socket.listen(0, "127.0.0.1", () => {
        const port = socket.address().port;
        socket.close((error) => (error ? fail(error) : done(port)));
      });
    });
    const env = {
      ...suiteEnv,
      TAURI_WEBDRIVER_PORT: String(port),
      STARTER_E2E_BINARY: binary,
      STARTER_E2E_DATA_ROOT: dataRoot,
      STARTER_E2E_PHASE: phase,
      STARTER_E2E_PORT: String(port),
    };
    const app = spawnOwned(binary, [], {
      cwd: root,
      env,
      logPath: join(root, "artifacts", "e2e", phase, "native.log"),
    });
    owned.push(app);
    let runner;
    try {
      await waitForWebDriver(app, port, cancellation.signal);
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
        { cwd: root, env },
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
    } finally {
      await stopOwned(runner);
      await stopOwned(app);
    }
  }
} catch (error) {
  preserveData = true;
  console.error(error.message);
  process.exitCode = cancellation.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  try {
    await suiteControl?.close();
  } catch (error) {
    preserveData = true;
    process.exitCode = 1;
    console.error(error.message);
  }
  if (suiteHost && !suiteHost.state.done && suiteCli && suiteEnv) {
    try {
      await stopSuiteHost();
    } catch (error) {
      preserveData = true;
      process.exitCode = 1;
      console.error(`Owned Host shutdown failed: ${error.message}`);
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
}
