import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants, userInfo } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  posix,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseOptions, runScenarios } from "./test-host-scenarios.mjs";

const helper = fileURLToPath(import.meta.url);
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export function parseOfflineOptions(args) {
  const options = parseOptions(args);
  if (!options.harness) throw new Error("Missing --harness <built harness>");
  return options;
}

function identity() {
  const status = readFileSync("/proc/self/status", "utf8");
  const namespace = statSync("/proc/self/ns/net");
  return {
    capturedAt: new Date().toISOString(),
    pid: process.pid,
    namespace: {
      target: readlinkSync("/proc/self/ns/net"),
      dev: namespace.dev,
      ino: namespace.ino,
    },
    uid: process.getuid(),
    euid: process.geteuid(),
    gid: process.getgid(),
    egid: process.getegid(),
    groups: process.getgroups(),
    capabilities: Object.fromEntries(
      [...status.matchAll(/^(Cap(?:Inh|Prm|Eff|Amb)):\s*([\da-f]+)$/gm)].map(
        (match) => [match[1], match[2]],
      ),
    ),
    status,
  };
}

function commandResult(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function captureNetwork(tools) {
  return {
    ...identity(),
    proc: Object.fromEntries(
      ["dev", "route", "ipv6_route"].map((name) => [
        name,
        readFileSync(`/proc/net/${name}`, "utf8"),
      ]),
    ),
    commands: Object.fromEntries(
      Object.entries({
        link: ["-j", "link", "show"],
        address: ["-j", "address", "show"],
        ipv4: ["-j", "-4", "route", "show", "table", "all"],
        ipv6: ["-j", "-6", "route", "show", "table", "all"],
      }).map(([name, args]) => [name, commandResult(tools.ip, args)]),
    ),
  };
}

function sameNamespace(left, right) {
  return (
    left?.target === right?.target &&
    left?.dev === right?.dev &&
    left?.ino === right?.ino
  );
}

export function validateOfflineSnapshot(snapshot, parent) {
  if (
    !/^net:\[\d+\]$/.test(snapshot.namespace?.target ?? "") ||
    !Number.isSafeInteger(snapshot.namespace.dev) ||
    !Number.isSafeInteger(snapshot.namespace.ino) ||
    snapshot.namespace.target === parent.namespace.target ||
    (snapshot.namespace.dev === parent.namespace.dev &&
      snapshot.namespace.ino === parent.namespace.ino)
  )
    throw new Error("Child network namespace is missing or not isolated");
  if (
    parent.uid === 0 ||
    ["uid", "euid", "gid", "egid"].some(
      (key) =>
        !Number.isInteger(snapshot[key]) || snapshot[key] !== parent[key],
    ) ||
    !Array.isArray(snapshot.groups) ||
    JSON.stringify([...snapshot.groups].sort((a, b) => a - b)) !==
      JSON.stringify([...parent.groups].sort((a, b) => a - b))
  )
    throw new Error("Runner identity was not restored");
  for (const key of ["CapInh", "CapPrm", "CapEff", "CapAmb"])
    if (!/^0+$/.test(snapshot.capabilities?.[key] ?? ""))
      throw new Error(`Unexpected child capability ${key}`);
  const values = {};
  for (const name of ["link", "address", "ipv4", "ipv6"]) {
    const result = snapshot.commands?.[name];
    if (!result || result.status !== 0 || result.signal || result.error)
      throw new Error(
        `Network probe ${name} failed: ${result?.error ?? result?.stderr ?? "missing result"}`,
      );
    values[name] = JSON.parse(result.stdout);
    if (!Array.isArray(values[name]))
      throw new Error(`Network probe ${name} must return a JSON array`);
  }
  if (
    values.link.length !== 1 ||
    values.link[0].ifname !== "lo" ||
    !Array.isArray(values.link[0].flags) ||
    !values.link[0].flags.includes("LOOPBACK") ||
    values.link[0].flags.includes("UP")
  )
    throw new Error(
      "Offline namespace must contain only the down loopback link",
    );
  if (
    values.address.length !== 1 ||
    values.address[0].ifname !== "lo" ||
    !Array.isArray(values.address[0].addr_info) ||
    values.address[0].addr_info.length !== 0
  )
    throw new Error("Offline namespace must have no IP address");
  if (values.ipv4.length || values.ipv6.length)
    throw new Error(
      "Offline namespace must have no IPv4 or IPv6 route in any table",
    );
}

export function namespaceCommand({
  tools,
  parent,
  output,
  helper: entry = helper,
}) {
  return {
    command: tools.sudo,
    args: [
      "-n",
      tools.unshare,
      "--net",
      tools.setpriv,
      `--reuid=${parent.uid}`,
      `--regid=${parent.gid}`,
      "--init-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      tools.env,
      "-i",
      `PATH=${parent.path}`,
      `HOME=${posix.join(output, "home")}`,
      `USER=${parent.user}`,
      `LOGNAME=${parent.user}`,
      "LC_ALL=C",
      `TMPDIR=${posix.join(output, "tmp")}`,
      tools.node,
      entry,
      "--inside",
      output,
    ],
  };
}

export function waitForNamespace(
  command,
  args,
  { spawnChild = spawn, signals = process, stdio = "inherit", cwd } = {},
) {
  return new Promise((resolveResult, reject) => {
    const child = spawnChild(command, args, { stdio, cwd, windowsHide: true });
    let interrupted;
    const forward = (signal) => {
      interrupted ??= signal;
      child.kill(signal);
    };
    const onInterrupt = () => forward("SIGINT");
    const onTerminate = () => forward("SIGTERM");
    const cleanup = () => {
      signals.removeListener("SIGINT", onInterrupt);
      signals.removeListener("SIGTERM", onTerminate);
    };
    signals.on("SIGINT", onInterrupt);
    signals.on("SIGTERM", onTerminate);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      resolveResult({ code, signal, interrupted });
    });
  });
}

export async function runIsolated(
  { output, parent, tools, options },
  { capture = captureNetwork, run = runScenarios } = {},
) {
  let before, failure, result;
  try {
    before = capture(tools);
    writeJson(join(output, "network/child-before.json"), before);
    validateOfflineSnapshot(before, parent);
    // Reuse every duration/evidence/owned-process gate in the original wrapper.
    result = await run(options);
  } catch (error) {
    failure = error;
  }
  try {
    const after = capture(tools);
    writeJson(join(output, "network/child-after.json"), after);
    validateOfflineSnapshot(after, parent);
    if (!sameNamespace(before?.namespace, after.namespace))
      throw new Error("Child network namespace changed during scenarios");
  } catch (error) {
    if (failure)
      failure = new Error(`${failure.message}; after probe: ${error.message}`, {
        cause: failure,
      });
    else failure = error;
  }
  writeJson(join(output, "child-result.json"), {
    complete: !failure,
    wrapper: result,
    error: failure?.message,
  });
  if (failure) throw failure;
  return result;
}

function findTool(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error(`Required offline tool not found: ${name}`);
}

function auditEvidence(path, uid) {
  const info = lstatSync(path);
  if (info.uid !== uid)
    throw new Error(`Evidence has unexpected owner: ${path}`);
  if (info.isDirectory()) {
    accessSync(path, constants.R_OK | constants.X_OK);
    for (const name of readdirSync(path)) auditEvidence(join(path, name), uid);
  } else if (info.isFile()) accessSync(path, constants.R_OK);
  else if (info.isSymbolicLink())
    throw new Error(`Evidence cannot be a symlink: ${path}`);
}

export async function runOffline(options) {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true")
    throw new Error(
      "Offline namespace scenarios require an independent Linux GitHub CI runner",
    );
  mkdirSync(dirname(options.output), { recursive: true });
  mkdirSync(options.output, { mode: 0o700 });
  for (const name of ["network", "tmp", "home"])
    mkdirSync(join(options.output, name), { mode: 0o700 });
  const parent = {
    ...identity(),
    user: userInfo().username,
    path: process.env.PATH,
  };
  writeJson(join(options.output, "network/parent-before.json"), parent);
  const record = {
    startedAt: new Date().toISOString(),
    sha: process.env.GITHUB_SHA,
    platform: process.platform,
    target: "x86_64-unknown-linux-gnu",
    node: process.version,
    options,
    parent,
  };
  let failure;
  try {
    if (parent.uid === 0)
      throw new Error("Offline scenarios require the normal runner identity");
    const tools = { node: realpathSync(process.execPath) };
    for (const name of ["sudo", "unshare", "setpriv", "env", "ip"])
      tools[name] = findTool(name);
    record.tools = Object.fromEntries(
      Object.entries(tools).map(([name, path]) => {
        const version = commandResult(path, [
          name === "ip" ? "-Version" : "--version",
        ]);
        if (version.status !== 0 || version.error || version.signal)
          throw new Error(
            `Cannot query ${name} version: ${version.error ?? version.stderr}`,
          );
        return [name, { path, version }];
      }),
    );
    const harness = realpathSync(options.harness);
    const directory = dirname(dirname(harness));
    record.binaries = [
      harness,
      ...["host", "cli", "mcp"].map((name) =>
        join(directory, `serial-workbench-${name}`),
      ),
    ].map((path) => {
      accessSync(path, constants.R_OK | constants.X_OK);
      if (!statSync(path).isFile())
        throw new Error(`Not a built binary: ${path}`);
      return {
        path: realpathSync(path),
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
    });
    const invocation = {
      output: options.output,
      parent,
      tools,
      options: {
        ...options,
        harness,
        output: join(options.output, "scenarios"),
      },
    };
    writeJson(join(options.output, "invocation.json"), invocation);
    record.command = namespaceCommand({
      tools,
      parent,
      output: options.output,
    });
    writeJson(join(options.output, "run.json"), record);
    const log = openSync(join(options.output, "launcher.log"), "wx");
    try {
      record.child = await waitForNamespace(
        record.command.command,
        record.command.args,
        { stdio: ["ignore", log, log], cwd: process.cwd() },
      );
    } finally {
      closeSync(log);
    }
    if (
      record.child.code !== 0 ||
      record.child.signal ||
      record.child.interrupted
    ) {
      const signal = record.child.interrupted ?? record.child.signal;
      const error = new Error(
        `Offline child failed: exit=${record.child.code}, signal=${signal ?? "none"}; see ${options.output}`,
      );
      error.exitCode =
        record.child.code ||
        (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1);
      throw error;
    }
    const readJson = (path) =>
      JSON.parse(readFileSync(join(options.output, path), "utf8"));
    const before = readJson("network/child-before.json");
    const after = readJson("network/child-after.json");
    validateOfflineSnapshot(before, parent);
    validateOfflineSnapshot(after, parent);
    if (!sameNamespace(before.namespace, after.namespace))
      throw new Error("Child namespace changed");
    if (
      readJson("child-result.json").complete !== true ||
      !statSync(join(options.output, "scenarios/summary.json")).isFile()
    )
      throw new Error("Missing completed wrapper evidence");
  } catch (error) {
    failure = error;
  }
  try {
    const after = identity();
    writeJson(join(options.output, "network/parent-after.json"), after);
    if (
      !sameNamespace(parent.namespace, after.namespace) ||
      parent.uid !== after.uid ||
      parent.euid !== after.euid
    )
      throw new Error("Parent namespace or identity changed");
    auditEvidence(options.output, parent.uid);
  } catch (error) {
    record.finalizationError = error.message;
    failure ??= error;
  }
  record.status = failure ? "failed" : "passed";
  record.error = failure?.message;
  record.endedAt = new Date().toISOString();
  writeJson(join(options.output, "run.json"), record);
  if (failure) throw failure;
  return record;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv[2] === "--inside") {
      if (process.platform !== "linux" || process.argv.length !== 4)
        throw new Error("Invalid Linux offline child invocation");
      const output = resolve(process.argv[3]);
      await runIsolated(
        JSON.parse(readFileSync(join(output, "invocation.json"), "utf8")),
      );
    } else {
      const options = parseOfflineOptions(process.argv.slice(2));
      await runOffline(options);
      console.log(`Offline scenario evidence: ${options.output}`);
    }
  } catch (error) {
    console.error(error);
    process.exitCode =
      Number.isInteger(error.exitCode) &&
      error.exitCode > 0 &&
      error.exitCode < 256
        ? error.exitCode
        : 1;
  }
}
