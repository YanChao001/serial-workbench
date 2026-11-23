import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { spawnOwned, stopOwned } from "../e2e/process.mjs";
import { fileSha256 } from "./artifact-lib.mjs";
import { bindWindowsUpdaterSignature } from "./hosting/windows-updater-signature.mjs";

function fixtureValue(name) {
  const value = process.env[`SWB_TEST_UPDATE_${name}`];
  assert.ok(value, `Missing update fixture setting ${name}`);
  return value;
}

const fixture = fixtureValue("DIRECTORY");
const evidence = fixtureValue("EVIDENCE");
const oldVersion = fixtureValue("OLD_VERSION");
const newVersion = fixtureValue("NEW_VERSION");
const oldSetup = fixtureValue("OLD_INSTALLER");
const newSetup = fixtureValue("NEW_INSTALLER");
const password = fixtureValue("PASSWORD");
const signingKey = fixtureValue("SIGNING_KEY");
const verifier = fixtureValue("VERIFIER");
const profile = join(fixture, "profile");
const install = join(fixture, "installed-suite");
const executable = join(install, "serial-workbench.exe");
const webview = join(fixture, "webview-data");
const config = JSON.parse(readFileSync("app.config.json", "utf8"));
const ignoredSecrets = /^SWB_TEST_UPDATE_/;
const testEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !ignoredSecrets.test(key)),
);

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    env: testEnv,
    encoding: "utf8",
    windowsHide: true,
    timeout: 45_000,
    ...options,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}

function powerShell(script, env = {}) {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...testEnv, ...env },
    },
  );
}

function registration() {
  return JSON.parse(
    powerShell(
      "Get-ItemProperty -LiteralPath ('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + $env:SWB_TEST_PRODUCT) | Select-Object DisplayVersion,DisplayName,InstallLocation,UninstallString,MainBinaryName,EstimatedSize | ConvertTo-Json -Compress",
      { SWB_TEST_PRODUCT: config.name },
    ),
  );
}

async function waitFor(check, timeout, description) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

function discovery() {
  return JSON.parse(
    readFileSync(join(profile, "host-v0", "discovery.json"), "utf8"),
  );
}

let observedDesktopVersion;

async function openDesktop(expectedVersion) {
  return waitFor(
    async () => {
      const port = Number(
        readFileSync(
          join(webview, "EBWebView", "DevToolsActivePort"),
          "utf8",
        ).split(/\r?\n/)[0],
      );
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
      const browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${port}`,
        { timeout: 2000 },
      );
      let matched = false;
      try {
        const pages = browser.contexts().flatMap((context) => context.pages());
        for (const page of pages) {
          if (!/^(?:https?:\/\/tauri\.localhost\/|tauri:\/\/)/.test(page.url()))
            continue;
          const version = await page.evaluate(() =>
            Promise.race([
              window.__TAURI_INTERNALS__?.invoke("plugin:app|version"),
              new Promise((resolve) => setTimeout(() => resolve(null), 750)),
            ]),
          );
          if (typeof version === "string") observedDesktopVersion = version;
          if (version === expectedVersion) {
            matched = true;
            return { browser, page };
          }
        }
        return null;
      } finally {
        if (!matched) await browser.close();
      }
    },
    45_000,
    `the installed desktop's WebView2 for version ${expectedVersion}`,
  );
}

function processIds(name = "serial-workbench") {
  const output = powerShell(
    "@(Get-Process -Name $env:SWB_TEST_PROCESS -ErrorAction SilentlyContinue | Where-Object Path -eq $env:SWB_TEST_EXE | ForEach-Object Id) -join ','",
    { SWB_TEST_PROCESS: name, SWB_TEST_EXE: join(install, `${name}.exe`) },
  );
  return output ? output.split(",").map(Number) : [];
}

const keyDirectory = join(fixture, "bound-signature");
console.log("staging and signing the candidate suite");
mkdirSync(keyDirectory);
const requestFile = join(keyDirectory, "stage.json");
const signed = bindWindowsUpdaterSignature({
  artifact: newSetup,
  version: newVersion,
  publicKey: config.updates.publicKey,
  activeInstall: install,
  directory: keyDirectory,
  sign: (file, version) =>
    run(
      process.execPath,
      [
        resolve("node_modules/@tauri-apps/cli/tauri.js"),
        "signer",
        "sign",
        "--private-key-path",
        signingKey,
        "--password",
        password,
        "--app-version",
        version,
        file,
      ],
      { timeout: 60_000 },
    ),
  runStage: (mode, request) => {
    writeFileSync(requestFile, JSON.stringify(request));
    return JSON.parse(run(verifier, [mode, requestFile], { timeout: 150_000 }));
  },
});
const candidateDesktop = fileSha256(
  join(signed.release.staged, "serial-workbench.exe"),
);
const signature = readFileSync(signed.signature, "utf8").trim();
let manifestRequests = 0;
let installerRequests = 0;
const server = createServer(
  {
    pfx: readFileSync(fixtureValue("PFX")),
    passphrase: password,
  },
  (request, response) => {
    if (request.method === "GET" && request.url === "/latest.json") {
      manifestRequests += 1;
      const entry = {
        url: `https://localhost:${server.address().port}/installer.exe`,
        signature,
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          version: newVersion,
          notes: "Isolated Windows desktop update",
          platforms: { "windows-x86_64": entry, "windows-x86_64-nsis": entry },
        }),
      );
    } else if (request.method === "GET" && request.url === "/installer.exe") {
      installerRequests += 1;
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": statSync(newSetup).size,
      });
      createReadStream(newSetup).pipe(response);
    } else {
      response.writeHead(404).end();
    }
  },
);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `https://localhost:${server.address().port}`;
console.log("loopback update server ready");

let owner;
let first;
let second;
let previous;
try {
  assert.deepEqual(processIds(), []);
  console.log("installing the registered previous suite");
  run(oldSetup, ["/S", `/D=${install}`], {
    windowsVerbatimArguments: true,
    timeout: 120_000,
  });
  const original = registration();
  assert.equal(original.DisplayVersion, oldVersion);
  assert.equal(original.InstallLocation, `"${install}"`);
  const originalDesktop = fileSha256(executable);
  assert.notEqual(originalDesktop, candidateDesktop);
  const deployment = join(testEnv.APPDATA, config.identifier);
  mkdirSync(deployment, { recursive: true });
  writeFileSync(
    join(deployment, "deployment.json"),
    JSON.stringify({ updates: { endpoint: `${base}/latest.json` } }),
  );
  mkdirSync(profile);
  const sentinel = join(profile, "acceptance-sentinel.txt");
  writeFileSync(sentinel, "profile retained", { flag: "wx" });

  owner = spawnOwned(executable, [], {
    cwd: install,
    logPath: join(evidence, "old-desktop.log"),
    env: {
      ...testEnv,
      SWB_PROFILE: profile,
      NO_PROXY: "localhost,127.0.0.1",
      WEBVIEW2_USER_DATA_FOLDER: webview,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=0",
    },
  });
  console.log("previous desktop started");
  first = await openDesktop(oldVersion);
  previous = await waitFor(discovery, 30_000, "the old Host identity");
  await first.page.evaluate(() => {
    location.hash = "/updates";
  });
  const check = /^(Check for updates|检查更新)$/;
  const installLabel = /^(Download and install|下载安装)$/;
  await first.page
    .getByRole("button", { name: check })
    .click({ timeout: 20_000 });
  await first.page
    .getByRole("button", { name: installLabel })
    .click({ timeout: 25_000 });
  await first.page
    .getByRole("dialog")
    .getByRole("button", { name: installLabel })
    .click({ timeout: 20_000 });
  console.log("desktop update confirmed");
  const oldExit = await waitFor(
    () => {
      const { exitCode, signalCode } = owner.child;
      return exitCode !== null || signalCode !== null
        ? { exitCode, signalCode }
        : null;
    },
    150_000,
    "the previous desktop process to exit",
  );
  assert.deepEqual(oldExit, { exitCode: 0, signalCode: null });
  assert.ok(!processIds().includes(owner.child.pid));
  console.log("previous desktop process exited");
  // WebView descendants can retain stdout/stderr handles after the owned process exits.
  await first.browser.close().catch(() => undefined);
  first = undefined;
  owner.child.stdout?.destroy();
  owner.child.stderr?.destroy();

  const newPid = await waitFor(
    () => processIds().find((pid) => pid !== owner.child.pid),
    35_000,
    "the automatically relaunched desktop",
  );
  console.log("replacement desktop process detected");
  assert.equal(fileSha256(executable), candidateDesktop);
  second = await openDesktop(newVersion);
  console.log("replacement desktop native version verified");
  await second.page.evaluate(() => {
    location.hash = "/";
  });
  await second.page
    .getByTestId("serial-workbench-shell")
    .waitFor({ timeout: 20_000 });
  const after = await waitFor(
    () => {
      const value = discovery();
      return BigInt(value.instanceEpoch) > BigInt(previous.instanceEpoch)
        ? value
        : null;
    },
    35_000,
    "the new Host instance",
  );
  assert.ok(processIds("serial-workbench-host").includes(after.pid));
  console.log("replacement Host instance verified");
  const updated = registration();
  assert.equal(updated.DisplayVersion, newVersion);
  for (const key of [
    "DisplayName",
    "InstallLocation",
    "UninstallString",
    "MainBinaryName",
  ]) {
    assert.equal(updated[key], original[key], key);
  }
  assert.equal(after.hostId, previous.hostId);
  assert.equal(readFileSync(sentinel, "utf8"), "profile retained");
  assert.ok(manifestRequests >= 1);
  assert.equal(installerRequests, 1);
  await second.page.evaluate(() => {
    location.hash = "/updates";
  });
  await second.page
    .getByRole("button", { name: check })
    .click({ timeout: 20_000 });
  const current = second.page.getByText(/^(Current version|当前版本)[：:]/);
  await current.waitFor({ timeout: 20_000 });
  assert.ok((await current.textContent()).includes(newVersion));
  writeFileSync(
    join(evidence, "receipt.json"),
    JSON.stringify(
      {
        oldVersion,
        newVersion,
        originalDesktop,
        candidateDesktop,
        oldPid: owner.child.pid,
        newPid,
        oldHostEpoch: previous.instanceEpoch,
        newHostEpoch: after.instanceEpoch,
        suiteDigest: signed.release.digest,
        manifestRequests,
        installerRequests,
        registrationPreserved: true,
        profilePreserved: true,
      },
      null,
      2,
    ),
  );
  console.log("updated desktop and Host verified");
} catch (error) {
  try {
    const coordinatorErrors = readdirSync(fixture, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith(".swb-update-"),
      )
      .flatMap((entry) => {
        try {
          return [
            readFileSync(join(fixture, entry.name, "update-error.txt"), "utf8"),
          ];
        } catch (readError) {
          if (readError.code === "ENOENT") return [];
          throw readError;
        }
      });
    const record = await Promise.resolve()
      .then(discovery)
      .catch(() => null);
    const hostNoticeCode = await second?.page
      .locator(".workbench-connection-notice-code")
      .first()
      .getAttribute("title", { timeout: 1500 })
      .catch(() => null);
    writeFileSync(
      join(evidence, "process-state.json"),
      JSON.stringify(
        {
          oldPid: owner?.child.pid,
          oldExitCode: owner?.child.exitCode,
          oldSignal: owner?.child.signalCode,
          oldLogClosed: owner?.state.done,
          desktopPids: processIds(),
          hostPids: processIds("serial-workbench-host"),
          observedDesktopVersion,
          previousHost: previous && {
            pid: previous.pid,
            instanceEpoch: previous.instanceEpoch,
          },
          observedHost: record && {
            pid: record.pid,
            instanceEpoch: record.instanceEpoch,
          },
          hostNoticeCode:
            typeof hostNoticeCode === "string" &&
            /^[A-Z][A-Z0-9_]+$/.test(hostNoticeCode)
              ? hostNoticeCode
              : null,
          manifestRequests,
          installerRequests,
          coordinatorErrors,
        },
        null,
        2,
      ),
    );
    const appLog = join(
      testEnv.LOCALAPPDATA,
      config.identifier,
      "logs",
      "app.log",
    );
    try {
      const entries = readFileSync(appLog, "utf8")
        .split(/\r?\n/)
        .filter((line) =>
          /Startup phase=|Application started v|Native Host state pump stopped/.test(
            line,
          ),
        )
        .slice(-40);
      writeFileSync(join(evidence, "desktop-startup.log"), entries.join("\n"));
    } catch (readError) {
      if (readError.code !== "ENOENT") throw readError;
    }
  } catch (snapshotError) {
    console.error("Cannot save Windows update process state", snapshotError);
  }
  throw error;
} finally {
  await first?.browser.close().catch(() => undefined);
  await second?.browser.close().catch(() => undefined);
  await stopOwned(owner);
  try {
    powerShell(
      "Get-Process -Name 'serial-workbench' -ErrorAction SilentlyContinue | Where-Object Path -eq $env:SWB_TEST_EXE | Stop-Process",
      { SWB_TEST_EXE: executable },
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
