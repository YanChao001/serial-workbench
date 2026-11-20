import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  createWriteStream,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const REQUIRED = {
  T01: [
    "three_clients_same_session",
    "rx_tx_hash",
    "partial_unknown_no_replay",
  ],
  T03: [
    "client_detach_continues",
    "shutdown_settled",
    "restart_epoch_no_replay",
  ],
  T04: ["capabilities", "partial_configuration", "break_cleanup_isolation"],
  T05: ["disk_failure_evidence", "rotation_recovery", "crash_prefix"],
  T06: ["slow_reader_isolated", "control_responsive", "loss_accounted"],
  T08: ["capture_after_detach", "finalize_verified", "replay_readonly_seek"],
};
const DURATION = 600;

export function parseOptions(args) {
  let output,
    harness,
    nodeRuntime,
    nodeParser,
    durationSeconds = DURATION;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (
      ![
        "--output",
        "--harness",
        "--duration-seconds",
        "--node-runtime",
        "--node-parser",
      ].includes(key)
    )
      throw new Error(`Unknown option: ${key}`);
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`${key} requires a value`);
    if (key === "--output") {
      if (output) throw new Error("Duplicate output");
      output = value;
    }
    if (key === "--harness") {
      if (harness) throw new Error("Duplicate harness");
      harness = value;
    }
    if (key === "--node-runtime") {
      if (nodeRuntime) throw new Error("Duplicate Node runtime");
      nodeRuntime = value;
    }
    if (key === "--node-parser") {
      if (nodeParser) throw new Error("Duplicate Node parser");
      nodeParser = value;
    }
    if (key === "--duration-seconds") {
      durationSeconds = Number(value);
      if (durationSeconds !== DURATION)
        throw new Error("Duration must be 600 seconds");
    }
  }
  if (!output) throw new Error("Missing --output evidence directory");
  if (Boolean(nodeRuntime) !== Boolean(nodeParser))
    throw new Error("Supply --node-runtime and --node-parser together");
  return {
    output: resolve(output),
    harness: harness ? resolve(harness) : undefined,
    durationSeconds,
    ...(nodeRuntime && nodeParser
      ? {
          nodeLoad: {
            runtime: resolve(nodeRuntime),
            parser: resolve(nodeParser),
          },
        }
      : {}),
  };
}

function evidencePath(root, path) {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Invalid evidence path: ${path}`);
  const base = realpathSync(root);
  let actual;
  try {
    actual = realpathSync(join(base, path));
  } catch {
    throw new Error(`Missing evidence: ${path}`);
  }
  const offset = relative(base, actual);
  if (
    !offset ||
    offset === ".." ||
    offset.startsWith(`..${sep}`) ||
    isAbsolute(offset) ||
    !statSync(actual).isFile()
  )
    throw new Error(`Invalid evidence path: ${path}`);
  return actual;
}
function number(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`Invalid ${label}`);
  return value;
}
function percentile(values, q) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
}

export function validateEvidence(
  root,
  result,
  wrapperElapsedSeconds,
  requireNode = false,
) {
  if (
    !result ||
    typeof result.version !== "string" ||
    !result.version ||
    typeof result.target !== "string" ||
    !result.target ||
    result.protocol !== "0.1"
  )
    throw new Error("Missing result version, target or protocol");
  if (
    typeof result.platform !== "string" ||
    !result.platform ||
    typeof result.startedAt !== "string" ||
    typeof result.endedAt !== "string" ||
    !Number.isFinite(Date.parse(result.startedAt)) ||
    !Number.isFinite(Date.parse(result.endedAt))
  )
    throw new Error("Missing platform or run time metadata");
  if (
    !Array.isArray(result.cases) ||
    result.cases.length !== Object.keys(REQUIRED).length
  )
    throw new Error("Missing scenario cases");
  const found = new Set();
  for (const entry of result.cases) {
    if (
      !entry ||
      !Object.hasOwn(REQUIRED, entry.id) ||
      found.has(entry.id) ||
      entry.status !== "passed" ||
      typeof entry.source !== "string" ||
      !entry.source
    )
      throw new Error("Invalid or failed scenario case");
    found.add(entry.id);
    if (
      !Array.isArray(entry.assertions) ||
      !Array.isArray(entry.evidence) ||
      !entry.evidence.length
    )
      throw new Error(`Missing assertion or evidence for ${entry.id}`);
    for (const path of entry.evidence) evidencePath(root, path);
    for (const name of REQUIRED[entry.id]) {
      const matching = entry.assertions.filter((item) => item?.name === name);
      if (
        matching.length !== 1 ||
        matching[0].passed !== true ||
        matching[0].actual === undefined ||
        matching[0].actual === null
      )
        throw new Error(`Missing or failed assertion ${entry.id}/${name}`);
    }
    if (entry.assertions.some((item) => item?.passed !== true))
      throw new Error(`Failed assertion in ${entry.id}`);
  }
  const t = result.telemetry;
  if (
    !t ||
    t.durationSeconds !== DURATION ||
    number(t.elapsedSeconds, "duration") < DURATION
  )
    throw new Error("Invalid 600 second duration");
  for (const key of ["rss", "queues", "controlLatency"])
    if (typeof t.sources?.[key] !== "string" || !t.sources[key])
      throw new Error(`Missing measurement source ${key}`);
  const samples = JSON.parse(
    readFileSync(evidencePath(root, t.samples), "utf8"),
  );
  if (
    !Array.isArray(samples) ||
    samples.length < 200 ||
    samples.length !== t.sampleCount
  )
    throw new Error("Invalid sample count");
  let previous = -1,
    previousBytes = -1;
  for (const s of samples) {
    const time = number(s.elapsedSeconds, "sample time");
    const bytes = number(s.bytesObserved, "sample bytes");
    if (
      time <= previous ||
      bytes < previousBytes ||
      (previous >= 0 && time - previous > 3)
    )
      throw new Error(
        "Sample times or byte counts are not monotonic or sample gap is too large",
      );
    for (const key of [
      "processTreeRssBytes",
      "sourceQueueBytes",
      "readerQueueBytes",
      "captureQueueBytes",
      "controlLatencyMs",
    ])
      number(s[key], `sample ${key}`);
    previous = time;
    previousBytes = bytes;
  }
  if (
    samples[0].elapsedSeconds > 3 ||
    previous < DURATION ||
    Math.abs(previous - t.elapsedSeconds) > 1 ||
    (wrapperElapsedSeconds !== undefined &&
      t.elapsedSeconds > number(wrapperElapsedSeconds, "wrapper duration") + 1)
  )
    throw new Error(
      "Sample duration does not match the measurement and wrapper time window",
    );
  if (
    number(t.processTreeRssBytesPeak, "RSS") !==
    Math.max(...samples.map((s) => s.processTreeRssBytes))
  )
    throw new Error("RSS summary differs from samples");
  for (const [peak, field] of [
    ["sourceQueueBytesPeak", "sourceQueueBytes"],
    ["readerQueueBytesPeak", "readerQueueBytes"],
    ["captureQueueBytesPeak", "captureQueueBytes"],
  ])
    if (number(t[peak], peak) < Math.max(...samples.map((s) => s[field])))
      throw new Error(`Invalid queue peak ${peak}`);
  const latencies = samples.map((s) => s.controlLatencyMs);
  for (const [key, q] of [
    ["p50", 0.5],
    ["p95", 0.95],
    ["p99", 0.99],
  ])
    if (
      number(t.controlLatencyMs?.[key], `latency ${key}`) !==
      percentile(latencies, q)
    )
      throw new Error(`Latency percentile ${key} differs from samples`);
  if (
    number(t.bytesProduced, "produced bytes") <= 0 ||
    t.bytesProduced !== t.bytesObserved ||
    number(t.bytesObserved, "observed bytes") !== previousBytes
  )
    throw new Error("Invalid throughput counters");
  if (requireNode) validateNodeLoad(root, result, samples);
  return { ...t, observedBytesPerSecond: t.bytesObserved / previous };
}

function validateNodeLoad(root, result, measurements) {
  const telemetry = result.telemetry;
  const node = telemetry.nodeDerived;
  const digest = /^[a-f0-9]{64}$/;
  if (
    node?.parserId !== "example.t06.parse" ||
    node.bytes !== telemetry.bytesObserved ||
    node.ownerExited !== true ||
    !Number.isSafeInteger(node.nodePid) ||
    node.nodePid <= 0 ||
    !digest.test(node.sha256) ||
    !digest.test(node.archiveSha256) ||
    !Number.isSafeInteger(node.samplesPublished) ||
    node.samplesPublished <= 64 ||
    node.samplesPublished !== node.samplesRead ||
    node.slowReaderError !== "CURSOR_EXPIRED" ||
    node.oldestPosition !== node.resumedAt ||
    !/^[1-9]\d*$/.test(node.oldestPosition) ||
    typeof node.slowAfter !== "number" ||
    node.slowAfter < 1 ||
    Number(node.oldestPosition) <= node.slowAfter + 1
  )
    throw new Error(
      "Missing or invalid Node parser, derived cursor or owner exit evidence",
    );
  const actual = result.cases
    .find((entry) => entry.id === "T06")
    .assertions.find((entry) => entry.name === "loss_accounted").actual;
  if (
    actual.fast?.sha256 !== node.sha256 ||
    actual.capture?.sha256 !== node.sha256 ||
    actual.capture.bytes !== node.bytes
  ) {
    throw new Error("Node parser, fast Raw reader and recorded bytes differ");
  }
  const archive = readFileSync(evidencePath(root, node.archive));
  if (createHash("sha256").update(archive).digest("hex") !== node.archiveSha256)
    throw new Error(
      "Node parser archive SHA-256 differs from the installed archive",
    );
  let offset = 0;
  let position = 0;
  const lines = readFileSync(evidencePath(root, node.samples), "utf8")
    .trimEnd()
    .split("\n");
  for (const line of lines) {
    const sample = JSON.parse(line);
    const sources = sample.provenance?.sources;
    const source = sources?.[0];
    const end = Number(source?.byteEnd);
    if (
      sample.position !== String(++position) ||
      sources?.length !== 1 ||
      source?.byteStart !== String(offset) ||
      !Number.isSafeInteger(end) ||
      source.byteEnd !== String(end) ||
      source.direction !== "rx" ||
      end <= offset ||
      sample.value !== end - offset ||
      sample.provenance.parserId !== node.parserId
    ) {
      throw new Error(
        "Derived sample sequence or byte provenance is incomplete",
      );
    }
    offset = end;
  }
  if (offset !== node.bytes || position !== node.samplesPublished)
    throw new Error("Derived sample evidence does not cover recorded input");
  const derived = measurements.map((sample) => sample.hostMetrics?.derived);
  for (const kind of ["retained", "reader"]) {
    let previousPeak = 0;
    let expectedLimit;
    for (const snapshot of [...derived, node.memoryAfterDrain]) {
      const budget = snapshot?.[kind];
      const [used, peak, limit] = ["usedBytes", "peakBytes", "limitBytes"].map(
        (key) => {
          const value = Number(budget?.[key]);
          if (
            !Number.isSafeInteger(value) ||
            value < 0 ||
            String(value) !== budget?.[key]
          ) {
            throw new Error(`Missing or invalid derived ${kind} memory budget`);
          }
          return value;
        },
      );
      expectedLimit ??= limit;
      if (
        limit !== expectedLimit ||
        limit === 0 ||
        used > peak ||
        peak > limit ||
        peak < previousPeak
      ) {
        throw new Error(`Invalid measured derived ${kind} queue peak or limit`);
      }
      previousPeak = peak;
    }
  }
  if (
    node.memoryAfterDrain.reader.usedBytes !== "0" ||
    node.memoryAfterDrain.reader.peakBytes === "0" ||
    node.memoryAfterDrain.retained.usedBytes === "0"
  ) {
    throw new Error(
      "Derived readers did not release their measured leases, or retention was not observed",
    );
  }
  for (const measurement of measurements) {
    const processes = measurement.ownedProcesses;
    if (
      measurement.hostMetrics?.node?.processId !== String(node.nodePid) ||
      !Array.isArray(processes) ||
      !processes.some(
        (owner) =>
          owner.pid === node.nodePid &&
          owner.role === "Node owner" &&
          owner.rssBytes > 0,
      ) ||
      processes.reduce(
        (total, owner) => total + number(owner.rssBytes, "owned RSS"),
        0,
      ) !== measurement.processTreeRssBytes
    ) {
      throw new Error(
        "Node owner RSS must be measured throughout the complete workload",
      );
    }
  }
}

export function runProcess(
  command,
  args,
  { logPath },
  {
    spawn: spawnChild = spawn,
    createLog = (path) => createWriteStream(path, { flags: "wx" }),
    signals = process,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    platform = process.platform,
    killGroup = (pid, signal) => process.kill(-pid, signal),
  } = {},
) {
  return new Promise((resolveResult, reject) => {
    const log = createLog(logPath);
    const child = spawnChild(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: platform !== "win32",
    });
    let reason,
      logError,
      timer,
      closed = false,
      closeResult,
      groupAbsent = false,
      settled = false;
    const onInterrupt = () => stop("SIGINT");
    const onTerminate = () => stop("SIGTERM");
    const cleanup = () => {
      clearTimer(timer);
      signals.removeListener("SIGINT", onInterrupt);
      signals.removeListener("SIGTERM", onTerminate);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolveResult(value);
    };
    const kill = (signal) => {
      try {
        if (platform === "win32") child.kill(signal);
        else if (!groupAbsent && Number.isInteger(child.pid) && child.pid > 0)
          killGroup(child.pid, signal);
      } catch (error) {
        if (platform !== "win32" && error.code === "ESRCH") groupAbsent = true;
        /* Otherwise wait for close or report unconfirmed. */
      }
    };
    const groupGone = () => {
      if (platform === "win32") return true;
      if (groupAbsent) return true;
      if (!Number.isInteger(child.pid) || child.pid <= 0) return false;
      try {
        killGroup(child.pid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") groupAbsent = true;
        return groupAbsent;
      }
    };
    const completeClosed = () => {
      if (!closed || !groupGone() || settled) return false;
      clearTimer(timer);
      if (logError) {
        log.destroy();
        finish(new Error(`Log error: ${logError.message}`));
        return true;
      }
      timer = setTimer(() => {
        log.destroy();
        finish(new Error("Cannot confirm log flush after owned child exit"));
      }, 5000);
      log.end(() =>
        finish(undefined, {
          code: reason ? null : closeResult.code,
          signal: reason ?? closeResult.signal,
        }),
      );
      return true;
    };
    const stop = (cause) => {
      if (reason || settled) return;
      if (closed && groupGone()) {
        log.destroy();
        finish(
          new Error(
            `Failed after owned child exit: ${cause}${logError ? `: ${logError.message}` : ""}`,
          ),
        );
        return;
      }
      reason = cause;
      clearTimer(timer);
      kill("SIGTERM");
      timer = setTimer(() => {
        if (completeClosed()) return;
        kill("SIGKILL");
        if (completeClosed()) return;
        timer = setTimer(() => {
          if (completeClosed()) return;
          child.stdout?.destroy();
          child.stderr?.destroy();
          log.destroy();
          child.unref?.();
          finish(
            new Error(
              `Cannot confirm owned ${platform === "win32" ? "child" : "process group"} stopped after ${reason}${logError ? `: ${logError.message}` : ""}`,
            ),
          );
        }, 5000);
      }, 5000);
    };
    signals.on("SIGINT", onInterrupt);
    signals.on("SIGTERM", onTerminate);
    timer = setTimer(() => stop("timeout"), 780000);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("error", (error) => {
      if (!child.pid) {
        log.destroy();
        finish(error);
      } else {
        logError = error;
        stop("child error");
      }
    });
    child.once("exit", () => {
      if (!settled && platform !== "win32" && !groupGone())
        stop("owned process group remained after harness exit");
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      closed = true;
      closeResult = { code, signal };
      if (completeClosed()) return;
      if (!reason) stop("owned process group remained after harness exit");
    });
    log.once("error", (error) => {
      logError = error;
      stop("log error");
    });
  });
}

export async function runScenarios(
  options,
  { run = runProcess, now = () => performance.now(), tempBase = tmpdir() } = {},
) {
  if (
    !options.harness ||
    !existsSync(options.harness) ||
    !statSync(options.harness).isFile()
  )
    throw new Error("Missing built scenario harness; provide --harness <path>");
  if (options.durationSeconds !== DURATION)
    throw new Error("Duration must be 600 seconds");
  if (
    options.nodeLoad &&
    (!existsSync(options.nodeLoad.runtime) ||
      !statSync(options.nodeLoad.runtime).isDirectory() ||
      !existsSync(options.nodeLoad.parser) ||
      !statSync(options.nodeLoad.parser).isFile())
  )
    throw new Error(
      "Provide prepared Node resources and the compiled SDK parser",
    );
  mkdirSync(options.output);
  const profile = mkdtempSync(join(tempBase, "swb-host-scenario-"));
  const resultPath = join(options.output, "result.json");
  const started = now();
  try {
    const result = await run(
      options.harness,
      [
        "--profile",
        profile,
        "--duration-seconds",
        String(DURATION),
        "--result",
        resultPath,
        "--log-dir",
        options.output,
        ...(options.nodeLoad
          ? [
              "--node-runtime",
              options.nodeLoad.runtime,
              "--node-parser",
              options.nodeLoad.parser,
            ]
          : []),
      ],
      { logPath: join(options.output, "harness.log") },
    );
    const elapsed = (now() - started) / 1000;
    if (result.code !== 0)
      throw new Error(
        `Scenario harness failed (${result.signal ?? result.code})`,
      );
    let report;
    try {
      report = JSON.parse(
        readFileSync(evidencePath(options.output, "result.json"), "utf8"),
      );
    } catch {
      throw new Error("Missing or invalid scenario result.json");
    }
    if (elapsed < DURATION)
      throw new Error("Harness finished before 600 seconds of monotonic time");
    if (
      !report.cleanup ||
      report.cleanup.complete !== true ||
      !Array.isArray(report.cleanup.ownedProcesses) ||
      report.cleanup.ownedProcesses.length === 0 ||
      report.cleanup.ownedProcesses.some(
        (p) => !Number.isInteger(p.pid) || p.pid <= 0 || p.exited !== true,
      )
    )
      throw new Error("Missing owned process cleanup evidence");
    const telemetry = validateEvidence(
      options.output,
      report,
      elapsed,
      Boolean(options.nodeLoad),
    );
    writeFileSync(
      join(options.output, "summary.json"),
      `${JSON.stringify({ version: report.version, target: report.target, platform: report.platform, protocol: report.protocol, startedAt: report.startedAt, endedAt: report.endedAt, wrapperElapsedSeconds: elapsed, observedBytesPerSecond: telemetry.observedBytesPerSecond, controlLatencyMs: telemetry.controlLatencyMs, processTreeRssBytesPeak: telemetry.processTreeRssBytesPeak }, null, 2)}\n`,
      { flag: "wx" },
    );
    rmSync(profile, { recursive: true });
    return { output: options.output, elapsedSeconds: elapsed };
  } catch (error) {
    throw new Error(
      `${error.message}; owned profile retained at ${profile}; evidence at ${options.output}`,
      { cause: error },
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await runScenarios(options);
    console.log(`Scenario evidence: ${result.output}`);
  } catch (error) {
    console.error(`Host scenarios failed: ${error.message}`);
    process.exitCode = 1;
  }
}
