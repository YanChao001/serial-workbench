import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  parseOptions,
  validateEvidence,
  runScenarios,
  runProcess,
} from "./test-host-scenarios.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "swb-evidence-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cases = ["T01", "T03", "T04", "T05", "T06", "T08"].map((id) => {
    const file = `${id}.log`;
    writeFileSync(join(root, file), `${id} observed assertion\n`);
    return {
      id,
      status: "passed",
      assertions: required[id].map((name) => ({
        name,
        passed: true,
        actual: true,
      })),
      source: "rust-harness",
      evidence: [file],
    };
  });
  writeFileSync(
    join(root, "samples.json"),
    JSON.stringify(
      Array.from({ length: 600 }, (_, index) => ({
        elapsedSeconds: index + 1,
        processTreeRssBytes: 100,
        controlLatencyMs: 1,
        bytesObserved: (index + 1) * 11520,
        sourceQueueBytes: 10,
        readerQueueBytes: 10,
        captureQueueBytes: 10,
      })),
    ),
  );
  return {
    root,
    result: {
      version: "1",
      platform: "linux",
      startedAt: "2026-11-08T00:00:00Z",
      endedAt: "2026-11-08T00:10:00Z",
      target: "x86_64-unknown-linux-gnu",
      protocol: "0.1",
      cases,
      telemetry: {
        durationSeconds: 600,
        sources: {
          rss: "os-process-tree",
          queues: "host-metrics",
          controlLatency: "client-monotonic",
        },
        elapsedSeconds: 600,
        sampleCount: 600,
        processTreeRssBytesPeak: 100,
        sourceQueueBytesPeak: 10,
        readerQueueBytesPeak: 10,
        captureQueueBytesPeak: 10,
        bytesProduced: 6912000,
        bytesObserved: 6912000,
        controlLatencyMs: { p50: 1, p95: 1, p99: 1 },
        samples: "samples.json",
      },
    },
  };
}

test("host scenarios require an explicit output and fixed M1 duration", () => {
  assert.throws(() => parseOptions([]), /output/i);
  assert.throws(
    () => parseOptions(["--output", "report", "--duration-seconds", "1"]),
    /duration|600/i,
  );
  assert.throws(
    () => parseOptions(["--output", "report", "--unknown"]),
    /unknown|unsupported/i,
  );
  assert.equal(parseOptions(["--output", "report"]).durationSeconds, 600);
});

test("evidence requires every named scenario, assertions and existing contained logs", (t) => {
  const { root, result } = fixture(t);
  assert.doesNotThrow(() => validateEvidence(root, result));
  const missing = structuredClone(result);
  missing.cases.pop();
  assert.throws(() => validateEvidence(root, missing), /T08|scenario/i);
  const empty = structuredClone(result);
  empty.cases[0].assertions = [];
  assert.throws(() => validateEvidence(root, empty), /assertion/i);
  const absent = structuredClone(result);
  absent.cases[0].evidence = ["missing.log"];
  assert.throws(() => validateEvidence(root, absent), /evidence|missing/i);
  const outside = structuredClone(result);
  outside.cases[0].evidence = ["../other.log"];
  assert.throws(() => validateEvidence(root, outside), /evidence|path/i);
});

test("a passed marker cannot replace 600-second telemetry and successful assertions", (t) => {
  const { root, result } = fixture(t);
  const failed = structuredClone(result);
  failed.cases[0].assertions[0].passed = false;
  assert.throws(() => validateEvidence(root, failed), /assertion|failed/i);
  const short = structuredClone(result);
  short.telemetry.elapsedSeconds = 3;
  assert.throws(() => validateEvidence(root, short), /duration|600/i);
  const unmeasured = structuredClone(result);
  delete unmeasured.telemetry.processTreeRssBytesPeak;
  assert.throws(() => validateEvidence(root, unmeasured), /rss|telemetry/i);
  writeFileSync(join(root, "samples.json"), "[]\n");
  assert.throws(() => validateEvidence(root, result), /sample/i);
});

const required = {
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

test("scenario success requires required named assertions and measured percentiles", (t) => {
  const { root, result } = fixture(t);
  const unnamed = structuredClone(result);
  unnamed.cases[0].assertions = [
    { name: "observed", passed: true, actual: true },
  ];
  assert.throws(() => validateEvidence(root, unnamed), /assertion/i);
  const mismatch = structuredClone(result);
  mismatch.telemetry.controlLatencyMs.p95 = 2;
  assert.throws(() => validateEvidence(root, mismatch), /latency|percentile/i);
  const fakePeak = structuredClone(result);
  fakePeak.telemetry.processTreeRssBytesPeak = 101;
  assert.throws(() => validateEvidence(root, fakePeak), /rss/i);
});

test("runner rejects missing harness before invoking a child", async (t) => {
  const { root } = fixture(t);
  let calls = 0;
  await assert.rejects(
    runScenarios(
      {
        output: join(root, "out"),
        harness: join(root, "missing"),
        durationSeconds: 600,
      },
      {
        run: async () => {
          calls++;
        },
      },
    ),
    /harness/i,
  );
  assert.equal(calls, 0);
});

test("runner preserves owned profile if harness omits its result", async (t) => {
  const { root } = fixture(t);
  const harness = join(root, "harness");
  writeFileSync(harness, "fixture");
  let profile;
  await assert.rejects(
    runScenarios(
      { output: join(root, "out"), harness, durationSeconds: 600 },
      {
        tempBase: root,
        now: (() => {
          let n = 0;
          return () => n++ * 600000;
        })(),
        run: async (_cmd, args) => {
          profile = args[args.indexOf("--profile") + 1];
          return { code: 0 };
        },
      },
    ),
    /result|evidence/i,
  );
  assert.ok(existsSync(profile));
});

test("scenario metrics require source attribution and a sustained series", (t) => {
  const { root, result } = fixture(t);
  const missing = structuredClone(result);
  delete missing.telemetry.sources;
  assert.throws(() => validateEvidence(root, missing), /source/i);
  const sparse = structuredClone(result);
  writeFileSync(
    join(root, "samples.json"),
    JSON.stringify([
      {
        elapsedSeconds: 1,
        processTreeRssBytes: 100,
        sourceQueueBytes: 10,
        readerQueueBytes: 10,
        captureQueueBytes: 10,
        controlLatencyMs: 1,
        bytesObserved: 11520,
      },
      {
        elapsedSeconds: 600,
        processTreeRssBytes: 100,
        sourceQueueBytes: 10,
        readerQueueBytes: 10,
        captureQueueBytes: 10,
        controlLatencyMs: 1,
        bytesObserved: 6912000,
      },
    ]),
  );
  sparse.telemetry.sampleCount = 2;
  assert.throws(() => validateEvidence(root, sparse), /sample/i);
});

test("runner does not accept a successful child before 600 seconds elapsed", async (t) => {
  const { root, result } = fixture(t);
  const harness = join(root, "harness");
  writeFileSync(harness, "fixture");
  await assert.rejects(
    runScenarios(
      { output: join(root, "out"), harness, durationSeconds: 600 },
      {
        tempBase: root,
        now: (() => {
          let n = 0;
          return () => n++ * 3000;
        })(),
        run: async (_cmd, args) => {
          writeFileSync(
            args[args.indexOf("--result") + 1],
            JSON.stringify(result),
          );
          return { code: 0 };
        },
      },
    ),
    /600|duration/i,
  );
});

test("runner archives verified evidence and removes only its owned profile", async (t) => {
  const { root, result } = fixture(t);
  const harness = join(root, "harness");
  writeFileSync(harness, "fixture");
  const unrelated = join(root, "unrelated");
  mkdirSync(unrelated);
  let profile;
  result.cleanup = {
    complete: true,
    ownedProcesses: [{ pid: 123, exited: true }],
  };
  const outcome = await runScenarios(
    { output: join(root, "out"), harness, durationSeconds: 600 },
    {
      tempBase: root,
      now: (() => {
        let n = 0;
        return () => n++ * 600000;
      })(),
      run: async (_cmd, args) => {
        profile = args[args.indexOf("--profile") + 1];
        const output = args[args.indexOf("--log-dir") + 1];
        for (const entry of result.cases)
          for (const file of entry.evidence)
            copyFileSync(join(root, file), join(output, file));
        copyFileSync(join(root, "samples.json"), join(output, "samples.json"));
        writeFileSync(
          args[args.indexOf("--result") + 1],
          JSON.stringify(result),
        );
        return { code: 0 };
      },
    },
  );
  assert.equal(outcome.elapsedSeconds, 600);
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(unrelated), true);
  assert.ok(existsSync(join(root, "out", "result.json")));
  assert.equal(
    JSON.parse(readFileSync(join(root, "out", "summary.json"), "utf8"))
      .observedBytesPerSecond,
    11520,
  );
});

test("evidence requires platform and wall-clock run identity", (t) => {
  const { root, result } = fixture(t);
  delete result.platform;
  assert.throws(() => validateEvidence(root, result), /platform|metadata/i);
});

test("throughput rejects duration outside actual sample and wrapper window", (t) => {
  const { root, result } = fixture(t);
  result.telemetry.elapsedSeconds = 1200;
  assert.throws(
    () => validateEvidence(root, result, 600),
    /duration|time|window/i,
  );
});

test("owned child timeout escalates and waits for close", async () => {
  const timers = new Map();
  let next = 0;
  const signals = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const log = new PassThrough();
  const pending = runProcess(
    "unused",
    [],
    { logPath: "unused" },
    {
      platform: "win32",
      spawn: () => child,
      createLog: () => log,
      signals: new EventEmitter(),
      setTimer: (fn, ms) => {
        const id = ++next;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    },
  );
  const fire = (ms) => {
    const entry = [...timers].find(([, timer]) => timer.ms === ms);
    assert.ok(entry, `missing timer ${ms}`);
    timers.delete(entry[0]);
    entry[1].fn();
  };
  fire(780000);
  assert.deepEqual(signals, ["SIGTERM"]);
  fire(5000);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null, "SIGKILL");
  assert.deepEqual(await pending, { code: null, signal: "timeout" });
});

test("log failure escalates then fails if held child cannot be confirmed stopped", async () => {
  const timers = new Map();
  let next = 0;
  const signals = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const log = new PassThrough();
  const pending = runProcess(
    "unused",
    [],
    { logPath: "unused" },
    {
      platform: "win32",
      spawn: () => child,
      createLog: () => log,
      signals: new EventEmitter(),
      setTimer: (fn, ms) => {
        const id = ++next;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    },
  );
  const rejected = assert.rejects(
    pending,
    /log.*cannot confirm|cannot confirm.*log/i,
  );
  log.emit("error", new Error("disk failed"));
  const fire = (ms) => {
    const entry = [...timers].find(([, timer]) => timer.ms === ms);
    assert.ok(entry, `missing timer ${ms}`);
    timers.delete(entry[0]);
    entry[1].fn();
  };
  fire(5000);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  fire(5000);
  await rejected;
});

test("log error waits for the held child to close before rejection", async () => {
  const timers = new Map();
  let next = 0;
  const sent = [];
  const child = new EventEmitter();
  child.pid = 42;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    sent.push(signal);
    return true;
  };
  const log = new PassThrough();
  const pending = runProcess(
    "unused",
    [],
    { logPath: "unused" },
    {
      platform: "win32",
      spawn: () => child,
      createLog: () => log,
      signals: new EventEmitter(),
      setTimer: (fn, ms) => {
        const id = ++next;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    },
  );
  let settled = false;
  pending.catch(() => {
    settled = true;
  });
  log.emit("error", new Error("disk failed"));
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(sent, ["SIGTERM"]);
  child.emit("close", null, "SIGTERM");
  await assert.rejects(pending, /log error.*disk failed/i);
  assert.equal(timers.size, 0);
});

test("allowed sample scheduling offset uses the final counter timestamp as denominator", (t) => {
  const { root, result } = fixture(t);
  result.telemetry.elapsedSeconds = 600.5;
  assert.equal(
    validateEvidence(root, result, 600).observedBytesPerSecond,
    11520,
  );
});

test("sample time cannot exceed actual wrapper runtime plus the one second allowance", (t) => {
  const { root, result } = fixture(t);
  const path = join(root, "samples.json");
  const samples = JSON.parse(readFileSync(path, "utf8"));
  for (const sample of samples) sample.elapsedSeconds += 1.5;
  writeFileSync(path, JSON.stringify(samples));
  result.telemetry.elapsedSeconds = 601.5;
  assert.throws(() => validateEvidence(root, result, 600), /duration|window/i);
});

test("log failure after confirmed child close never signals that child", async () => {
  const timers = new Map();
  let next = 0;
  const sent = [];
  const child = new EventEmitter();
  child.pid = 42;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    sent.push(signal);
    return true;
  };
  const log = new PassThrough();
  const pending = runProcess(
    "unused",
    [],
    { logPath: "unused" },
    {
      platform: "win32",
      spawn: () => child,
      createLog: () => log,
      signals: new EventEmitter(),
      setTimer: (fn, ms) => {
        const id = ++next;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    },
  );
  const rejected = assert.rejects(pending, /log error/i);
  child.emit("close", 0, null);
  log.emit("error", new Error("late log failure"));
  assert.deepEqual(sent, []);
  await rejected;
});

test("POSIX timeout signals only its detached group and waits after leader closes", async () => {
  const timers = new Map();
  let next = 0,
    alive = true;
  const sent = [];
  let spawnOptions;
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => assert.fail("POSIX must signal its owned group");
  const log = new PassThrough();
  const pending = runProcess(
    "unused",
    [],
    { logPath: "unused" },
    {
      platform: "linux",
      spawn: (_c, _a, opts) => {
        spawnOptions = opts;
        return child;
      },
      killGroup: (pid, signal) => {
        assert.equal(pid, 4321);
        if (signal === 0) {
          if (!alive) {
            const e = new Error("absent");
            e.code = "ESRCH";
            throw e;
          }
          return;
        }
        sent.push(signal);
        if (signal === "SIGKILL") alive = false;
      },
      createLog: () => log,
      signals: new EventEmitter(),
      setTimer: (fn, ms) => {
        const id = ++next;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    },
  );
  const fire = (ms) => {
    const entry = [...timers].find(([, timer]) => timer.ms === ms);
    assert.ok(entry);
    timers.delete(entry[0]);
    entry[1].fn();
  };
  assert.equal(spawnOptions.detached, true);
  fire(780000);
  assert.deepEqual(sent, ["SIGTERM"]);
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  child.emit("close", null, "SIGTERM");
  await Promise.resolve();
  assert.equal(settled, false);
  fire(5000);
  assert.deepEqual(sent, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(await pending, { code: null, signal: "timeout" });
});

test("POSIX leader exit cannot prove its still-live group is gone", async () => {
  const timers = new Map();
  let next = 0;
  const sent = [];
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const pending = runProcess(
    "unused",
    [],
    { logPath: "unused" },
    {
      platform: "linux",
      spawn: () => child,
      killGroup: (_pid, signal) => {
        if (signal !== 0) sent.push(signal);
      },
      createLog: () => new PassThrough(),
      signals: new EventEmitter(),
      setTimer: (fn, ms) => {
        const id = ++next;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    },
  );
  const rejected = assert.rejects(pending, /cannot confirm.*group/i);
  const fire = (ms) => {
    const entry = [...timers].find(([, timer]) => timer.ms === ms);
    assert.ok(entry);
    timers.delete(entry[0]);
    entry[1].fn();
  };
  child.emit("close", 0, null);
  assert.deepEqual(sent, ["SIGTERM"]);
  fire(5000);
  assert.deepEqual(sent, ["SIGTERM", "SIGKILL"]);
  fire(5000);
  await rejected;
});

test("POSIX successful leader exit requires its owned group to be absent", async () => {
  let spawnOptions;
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const pending = runProcess(
    "unused",
    [],
    { logPath: "unused" },
    {
      platform: "darwin",
      spawn: (_c, _a, options) => {
        spawnOptions = options;
        return child;
      },
      killGroup: (_pid, signal) => {
        assert.equal(signal, 0);
        const e = new Error("absent");
        e.code = "ESRCH";
        throw e;
      },
      createLog: () => new PassThrough(),
      signals: new EventEmitter(),
    },
  );
  assert.equal(spawnOptions.detached, true);
  child.emit("close", 0, null);
  assert.deepEqual(await pending, { code: 0, signal: null });
});

test("Windows timeout signals only its child and does not detach", async () => {
  let spawnOptions, tick;
  const calls = [];
  const child = new EventEmitter();
  child.pid = 55;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => calls.push(signal);
  const pending = runProcess(
    "unused",
    [],
    { logPath: "unused" },
    {
      platform: "win32",
      spawn: (_c, _a, options) => {
        spawnOptions = options;
        return child;
      },
      killGroup: () => assert.fail("Windows must not signal a POSIX group"),
      createLog: () => new PassThrough(),
      signals: new EventEmitter(),
      setTimer: (fn, ms) => {
        if (ms === 780000) tick = fn;
        return 1;
      },
      clearTimer: () => {},
    },
  );
  assert.equal(spawnOptions.detached, false);
  tick();
  assert.deepEqual(calls, ["SIGTERM"]);
  child.emit("close", null, "SIGTERM");
  assert.deepEqual(await pending, { code: null, signal: "timeout" });
});

test("POSIX leader exit starts cleanup even if descendants keep its pipes open", async () => {
  const timers = new Map();
  let next = 0;
  const sent = [];
  let alive = true;
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const pending = runProcess(
    "unused",
    [],
    { logPath: "unused" },
    {
      platform: "linux",
      spawn: () => child,
      killGroup: (_pid, signal) => {
        if (signal === 0) {
          if (!alive) {
            const e = new Error("gone");
            e.code = "ESRCH";
            throw e;
          }
          return;
        }
        sent.push(signal);
        if (signal === "SIGKILL") alive = false;
      },
      createLog: () => new PassThrough(),
      signals: new EventEmitter(),
      setTimer: (fn, ms) => {
        const id = ++next;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    },
  );
  child.emit("exit", 0, null);
  assert.deepEqual(sent, ["SIGTERM"]);
  const entry = [...timers].find(([, timer]) => timer.ms === 5000);
  assert.ok(entry);
  timers.delete(entry[0]);
  entry[1].fn();
  assert.deepEqual(sent, ["SIGTERM", "SIGKILL"]);
  child.emit("close", 0, null);
  assert.equal((await pending).code, null);
});

test("POSIX group absence remains final through a late log error", async () => {
  const sent = [];
  let probes = 0,
    reused = false;
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const log = new PassThrough();
  const pending = runProcess(
    "unused",
    [],
    { logPath: "unused" },
    {
      platform: "linux",
      spawn: () => child,
      killGroup: (pid, signal) => {
        assert.equal(pid, 4321);
        if (signal === 0) {
          probes++;
          if (!reused) {
            const error = new Error("absent");
            error.code = "ESRCH";
            throw error;
          }
          return;
        }
        sent.push(signal);
      },
      createLog: () => log,
      signals: new EventEmitter(),
    },
  );
  const rejected = assert.rejects(pending, /log error/i);
  child.emit("close", 0, null);
  reused = true;
  log.emit("error", new Error("late error"));
  assert.deepEqual(sent, []);
  assert.equal(probes, 1);
  await rejected;
});

test("POSIX exit absence prevents later signal and close from probing a reused ID", async () => {
  const sent = [];
  let probes = 0,
    reused = false;
  const signals = new EventEmitter();
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const pending = runProcess(
    "unused",
    [],
    { logPath: "unused" },
    {
      platform: "linux",
      spawn: () => child,
      killGroup: (pid, signal) => {
        assert.equal(pid, 4321);
        if (signal === 0) {
          probes++;
          if (!reused) {
            const error = new Error("absent");
            error.code = "ESRCH";
            throw error;
          }
          return;
        }
        sent.push(signal);
      },
      createLog: () => new PassThrough(),
      signals,
    },
  );
  child.emit("exit", 0, null);
  reused = true;
  signals.emit("SIGINT");
  child.emit("close", 0, null);
  assert.deepEqual(sent, []);
  assert.equal(probes, 1);
  assert.deepEqual(await pending, { code: null, signal: "SIGINT" });
});

test("POSIX ESRCH on owned-group signal also permanently ends group access", async () => {
  const sent = [];
  let probes = 0;
  const signals = new EventEmitter();
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const pending = runProcess(
    "unused",
    [],
    { logPath: "unused" },
    {
      platform: "linux",
      spawn: () => child,
      killGroup: (_pid, signal) => {
        if (signal === 0) {
          probes++;
          return;
        }
        sent.push(signal);
        const error = new Error("absent");
        error.code = "ESRCH";
        throw error;
      },
      createLog: () => new PassThrough(),
      signals,
    },
  );
  signals.emit("SIGINT");
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  assert.deepEqual(sent, ["SIGTERM"]);
  assert.equal(probes, 0);
  assert.deepEqual(await pending, { code: null, signal: "SIGINT" });
});
