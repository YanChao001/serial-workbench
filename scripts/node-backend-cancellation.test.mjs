import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { removeProjectPath } from "./fs-utils.mjs";

const project = resolve(import.meta.dirname, "..");
const backend = join(project, "crates/host/src/node_backend");
const rawFlag = 0x8000_0000;

async function* frames(stream) {
  let buffered = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const header = buffered.readUInt32LE();
      const raw = header >= rawFlag;
      const length = raw ? header - rawFlag : header;
      assert.ok(length > 0 && length <= 1024 * 1024);
      if (buffered.length < 4 + length) break;
      const frame = JSON.parse(buffered.subarray(4, 4 + length).toString());
      buffered = buffered.subarray(4 + length);
      yield { raw, frame };
    }
  }
}

test("a cancelled Raw reply aborts the task before the control frame arrives", (t) =>
  cancelRawTask(t, "actions"));

test("a registered parser uses the same Raw task and cancellation lane", (t) =>
  cancelRawTask(t, "parsers"));

test("configuration handlers must match the signed kind", async (t) => {
  const id = "example.config";
  const actionId = id + ".test";
  const registerQuery = `context.configuration.registerQuery("${actionId}", () => 7);`;
  const registerAction = `context.configuration.registerAction("${actionId}", () => 7);`;
  const manuallySelected = `
    context.actions.register("${actionId}", () => 7);
    context.contributions.register({
      actions: [], queries: [], transports: [], parsers: [],
      views: [], themes: [], configuration: ["${actionId}"],
    });
  `;
  for (const [description, registration, kind, accepted] of [
    ["declared query", registerQuery, "query", true],
    ["declared action", registerAction, "action", true],
    ["an action registered for a query", registerAction, "query", false],
    ["a query registered for an action", registerQuery, "action", false],
    [
      "an explicitly selected query with an action handler",
      manuallySelected,
      "query",
      false,
    ],
  ]) {
    await t.test(description, (subtest) =>
      withBackend(
        subtest,
        `export function register(context) { ${registration} return () => {}; }`,
        async ({ root, entry, send, output }) => {
          for await (const { frame } of output) {
            if (frame.kind === "ready") {
              send({
                kind: "activate",
                requestId: "1",
                id,
                root,
                entry,
                configurationKinds: { [actionId]: kind },
              });
            } else if (frame.requestId === "1") {
              assert.equal(frame.kind, accepted ? "registered" : "failed");
              if (!accepted) return;
              assert.deepEqual(frame.contributes.configuration, [actionId]);
              send(
                kind === "query"
                  ? { kind: "query", requestId: "2", id, query: { actionId } }
                  : { kind: "invoke", requestId: "2", id, call: { actionId } },
              );
            } else if (frame.requestId === "2") {
              assert.equal(
                frame.kind,
                kind === "query" ? "queried" : "action_completed",
              );
              assert.equal(frame.value, 7);
              return;
            }
          }
          assert.fail("Node closed before settling configuration registration");
        },
      ),
    );
  }
});

test("a script runs in a managed worker and reads via the parent task lane", (t) =>
  runManagedScript(t, false));

test("cancelling a script with a pending Raw read waits for worker exit", (t) =>
  runManagedScript(t, true));

async function runManagedScript(t, cancel) {
  const id = "swb.builtin.automation";
  const actionId = id + ".script";
  const source =
    'export default async ({ serial, log }) => { const page = await serial.read("17"); log(page.nextEventSeq); return page.events.length; };';
  const sourceSha256 = createHash("sha256")
    .update("serial-workbench-script-v1\0js\0")
    .update(source)
    .digest("hex");
  await withBackend(
    t,
    'export function register(context) { context.actions.register("' +
      actionId +
      '", (call, task) => context.workers.runConfirmedScript(call.params, { read: (startEventSeq) => task.streams.read({ sessionId: "device-1", sessionEpoch: "7", startEventSeq, maxEvents: "32", maxBytes: "65536" }) })); return () => {}; }',
    async ({ root, entry, send, output }) => {
      let read = false;
      for await (const { raw, frame } of output) {
        if (raw) {
          assert.equal(read, false);
          read = true;
          assert.equal(frame.parentRequestId, "2");
          assert.equal(frame.parentOperationId, "parent");
          assert.equal(frame.taskContext, "owned");
          assert.deepEqual(frame.params, {
            sessionId: "device-1",
            sessionEpoch: "7",
            startEventSeq: "17",
            maxEvents: "32",
            maxBytes: "65536",
          });
          if (cancel) send({ kind: "cancel_action", requestId: "2" });
          const reply = cancel
            ? {
                ok: false,
                error: { code: "CANCELLED", message: "parent cancelled" },
              }
            : {
                ok: true,
                result: {
                  kind: "stream_read",
                  nextEventSeq: "18",
                  events: [],
                  hasMore: false,
                },
              };
          send({ requestId: frame.requestId, reply }, rawFlag);
        } else if (frame.kind === "ready") {
          send({ kind: "activate", requestId: "1", id, root, entry });
        } else if (frame.requestId === "1") {
          assert.equal(frame.kind, "registered");
          send({
            kind: "invoke",
            requestId: "2",
            id,
            call: {
              actionId,
              params: { language: "js", source, sourceSha256 },
            },
            taskContext: "owned",
            parentOperationId: "parent",
          });
        } else if (
          frame.requestId === "2" &&
          frame.kind !== "action_stopping"
        ) {
          assert.equal(
            frame.kind,
            cancel ? "action_cancelled" : "action_completed",
          );
          assert.equal(read, true);
          if (!cancel) {
            assert.deepEqual(frame.value, {
              kind: "completed",
              logs: ["18"],
              value: 0,
            });
          }
          assert.equal(frame.observation.workerObservation.liveWorkers, "0");
          assert.equal(frame.observation.workerObservation.peakWorkers, "1");
          return;
        }
      }
      assert.fail("Node closed before settling the script task");
    },
  );
}

test("script breakpoints expose exact TS frames while an adjacent Raw task and plugin activation continue", (t) =>
  runDebuggerTask(t, false));

test("cancelling a paused script reaps its worker with no later Raw read", (t) =>
  runDebuggerTask(t, true));

async function runDebuggerTask(t, cancel) {
  const id = "swb.builtin.automation";
  const actionId = id + ".script";
  const adjacentAction = id + ".adjacent";
  const warmup = 'export default () => "ready";';
  const warmupDigest = createHash("sha256")
    .update("serial-workbench-script-v1\0js\0")
    .update(warmup)
    .digest("hex");
  const source = [
    "export default async ({ serial }: { serial: { read(sequence: string): Promise<unknown> } }) => {",
    "  const data = 14;",
    "  function compute(value: number) {",
    "    const count = value + 2;",
    "    return count;",
    "  }",
    "  const count = compute(data);",
    '  return { count, received: await serial.read("17") };',
    "};",
  ].join("\n");
  const sourceSha256 = createHash("sha256")
    .update("serial-workbench-script-v1\0ts\0")
    .update(source)
    .digest("hex");
  await withBackend(
    t,
    `export function register(context) {
      const read = (task, startEventSeq) => task.streams.read({ sessionId: "device-1", sessionEpoch: "7", startEventSeq, maxEvents: "32", maxBytes: "65536" });
      context.actions.register("${adjacentAction}", (_call, task) => read(task, "33"));
      context.actions.register("${actionId}", (call, task) =>
        context.workers.runConfirmedScript(call.params, { read: (startEventSeq) => read(task, startEventSeq) }));
      return () => {};
    }`,
    async ({ root, entry, send, output }) => {
      const neighborId = "example.debugprobe";
      const neighbor = join(root, "neighbor.mjs");
      writeFileSync(
        neighbor,
        `import { url } from "node:inspector";
        export function register(context) {
          context.queries.register("${neighborId}.listen", () => ({ inspector: url() ?? null }));
          return () => {};
        }`,
      );
      const debug = (requestId, action, revision, frame) =>
        send({
          kind: "script_debug_command",
          requestId,
          actionRequestId: "2",
          command: {
            action,
            revision,
            ...(frame === undefined ? {} : { frame }),
          },
        });
      let firstPause;
      let secondPause;
      let selectedPause;
      let adjacent = false;
      let backendAvailable = false;
      let rawReads = 0;
      let staleRejected = false;
      let continued = false;
      for await (const { raw, frame } of output) {
        if (raw) {
          const script = frame.parentRequestId === "2";
          if (script) {
            assert.equal(cancel, false);
            assert.ok(continued);
            assert.equal(frame.params.startEventSeq, "17");
            rawReads++;
          } else {
            assert.ok(firstPause);
            assert.equal(frame.parentRequestId, "3");
            assert.equal(frame.params.startEventSeq, "33");
          }
          send(
            {
              requestId: frame.requestId,
              reply: {
                ok: true,
                result: {
                  kind: "stream_read",
                  nextEventSeq: "34",
                  events: [],
                  hasMore: false,
                },
              },
            },
            rawFlag,
          );
        } else if (frame.kind === "ready") {
          send({ kind: "activate", requestId: "1", id, root, entry });
        } else if (frame.kind === "registered" && frame.requestId === "1") {
          send({
            kind: "invoke",
            requestId: "4",
            id,
            call: {
              actionId,
              params: {
                language: "js",
                source: warmup,
                sourceSha256: warmupDigest,
              },
            },
            taskContext: "warmup",
            parentOperationId: "warmup-parent",
          });
        } else if (
          frame.kind === "action_completed" &&
          frame.requestId === "4"
        ) {
          assert.equal(frame.value.value, "ready");
          send({
            kind: "invoke",
            requestId: "2",
            id,
            call: {
              actionId,
              params: { language: "ts", source, sourceSha256 },
            },
            taskContext: "owned",
            parentOperationId: "debug-parent",
            scriptBreakpoints: [7],
          });
        } else if (
          frame.kind === "script_debug_snapshot" &&
          frame.value.phase === "paused"
        ) {
          assert.equal(frame.requestId, "2");
          const snapshot = frame.value;
          if (!firstPause) {
            firstPause = snapshot.revision;
            assert.equal(snapshot.frames[0].line, 7);
            assert.equal(
              snapshot.variables.find(({ name }) => name === "data").preview,
              "14",
            );
            send({
              kind: "invoke",
              requestId: "3",
              id,
              call: { actionId: adjacentAction },
              taskContext: "adjacent",
              parentOperationId: "neighbor-task",
            });
            send({
              kind: "activate",
              requestId: "10",
              id: neighborId,
              root,
              entry: neighbor,
            });
          } else if (!secondPause) {
            secondPause = snapshot.revision;
            assert.ok(adjacent && backendAvailable);
            assert.equal(snapshot.frames[0].name, "compute");
            assert.equal(snapshot.frames[0].line, 4);
            assert.equal(snapshot.frames[1].line, 7);
            assert.equal(
              snapshot.variables.find(({ name }) => name === "value").preview,
              "14",
            );
            debug("14", "inspectFrame", secondPause, 1);
          } else {
            selectedPause = snapshot.revision;
            assert.equal(snapshot.selectedFrame, 1);
            assert.equal(
              snapshot.variables.find(({ name }) => name === "data").preview,
              "14",
            );
            debug("15", "continue", secondPause);
          }
        } else if (frame.kind === "registered" && frame.requestId === "10") {
          send({
            kind: "query",
            requestId: "11",
            id: neighborId,
            query: { actionId: neighborId + ".listen" },
          });
        } else if (frame.kind === "queried" && frame.requestId === "11") {
          assert.deepEqual(frame.value, { inspector: null });
          backendAvailable = true;
          if (adjacent) debug("12", "stepInto", firstPause);
        } else if (
          frame.kind === "action_completed" &&
          frame.requestId === "3"
        ) {
          adjacent = true;
          if (backendAvailable) debug("12", "stepInto", firstPause);
        } else if (
          frame.kind === "script_debug_reply" &&
          frame.requestId === "15"
        ) {
          assert.equal(frame.outcome, "REVISION_CONFLICT");
          staleRejected = true;
          if (cancel) send({ kind: "cancel_action", requestId: "2" });
          else {
            continued = true;
            debug("16", "continue", selectedPause);
          }
        } else if (
          frame.requestId === "2" &&
          (frame.kind === "action_completed" ||
            frame.kind === "action_cancelled")
        ) {
          assert.ok(
            firstPause && secondPause && selectedPause && staleRejected,
          );
          assert.equal(
            frame.kind,
            cancel ? "action_cancelled" : "action_completed",
          );
          assert.equal(frame.observation.workerObservation.liveWorkers, "0");
          assert.equal(frame.observation.workerObservation.peakWorkers, "1");
          assert.equal(rawReads, cancel ? 0 : 1);
          if (!cancel) assert.equal(frame.value.value.count, 16);
          return;
        }
      }
      assert.fail("Node closed before settling the debug task");
    },
  );
}

async function withBackend(t, source, run) {
  const parent = join(project, ".cache/script-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "node-backend-"));
  t.after(() => {
    if (t.passed) removeProjectPath(project, relative(project, root));
  });
  const entry = join(root, "fixture.mjs");
  writeFileSync(entry, source);
  const loader = readFileSync(join(backend, "loader.mjs"), "utf8");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `process.argv[2] = String(process.pid);\n${loader}`,
      String(process.pid),
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  let pipeError;
  child.stdin.on("error", (error) => {
    pipeError = error;
  });
  const exited = once(child, "close").catch((error) => {
    pipeError = error;
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  const send = (payload, flag = 0) => {
    const body = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(JSON.stringify(payload));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length + flag);
    child.stdin.write(Buffer.concat([header, body]));
  };
  try {
    const workerSource = readFileSync(
      join(backend, "script-worker.mjs"),
      "utf8",
    );
    const bootstrap = readFileSync(join(backend, "bootstrap.mjs"), "utf8");
    const debuggerSource = readFileSync(
      join(backend, "script-debugger.mjs"),
      "utf8",
    );
    send(
      Buffer.from(
        "const scriptWorkerSource = " +
          JSON.stringify(workerSource) +
          ";\n" +
          debuggerSource +
          "\n" +
          bootstrap,
      ),
    );
    await run({ root, entry, send, output: frames(child.stdout) });
  } finally {
    clearTimeout(timeout);
    child.kill();
    await exited;
  }
  if (pipeError) throw pipeError;
}

async function cancelRawTask(t, group) {
  const actionId = "example.cancel.test";
  await withBackend(
    t,
    `export function register(context) {
      context[${JSON.stringify(group)}].register(${JSON.stringify(actionId)}, (_, task) => task.streams.read({}));
      return () => {};
    }`,
    async ({ root, entry, send, output }) => {
      let rawReplySent = false;
      for await (const { raw, frame } of output) {
        if (raw) {
          assert.equal(rawReplySent, false);
          rawReplySent = true;
          send(
            {
              requestId: frame.requestId,
              reply: {
                ok: false,
                error: { code: "CANCELLED", message: "parent cancelled" },
              },
            },
            rawFlag,
          );
        } else if (frame.kind === "ready") {
          send({
            kind: "activate",
            requestId: "1",
            id: "example.cancel",
            root,
            entry,
          });
        } else if (frame.requestId === "1") {
          assert.equal(frame.kind, "registered");
          assert.deepEqual(frame.contributes[group], [actionId]);
          send({
            kind: "invoke",
            requestId: "2",
            id: "example.cancel",
            call: { actionId },
            taskContext: "owned",
            parentOperationId: "parent",
          });
        } else if (frame.requestId === "2") {
          assert.equal(rawReplySent, true);
          assert.equal(frame.kind, "action_cancelled");
          return;
        }
      }
      assert.fail("Node closed before reporting cancellation");
    },
  );
}

test("session hooks follow one page at a time through source termination", (t) =>
  runSessionHooks(t));

test("session hooks close the reader before reporting a callback failure", (t) =>
  runSessionHooks(t, { callbackFails: true }));

test("session hooks resume after a retention gap without creating an open event", (t) =>
  runSessionHooks(t, { expiredScope: "raw:session:7" }));

test("session hooks close without delivering a retention cursor from another session", (t) =>
  runSessionHooks(t, { expiredScope: "raw:other:7" }));

test("session hooks drop late replies after an active receive callback is cancelled", (t) =>
  runSessionHooks(t, { cancelPending: true }));

async function runSessionHooks(
  t,
  { callbackFails = false, cancelPending = false, expiredScope } = {},
) {
  const id = "example.hooks";
  const actionId = id + ".follow";
  const inspectId = id + ".inspect";
  const source = {
    hostId: "host",
    instanceEpoch: "3",
    sessionId: "session",
    sessionEpoch: "7",
  };
  const params = {
    sessionId: source.sessionId,
    sessionEpoch: source.sessionEpoch,
    startEventSeq: "1",
    maxEvents: "32",
    maxBytes: "262144",
  };
  const next = { ...params, startEventSeq: "6" };
  const tx = {
    operationId: "write",
    bytesBase64: "Ag==",
    byteStart: "0",
    byteEnd: "1",
  };
  const events = [
    { kind: "lifecycle", payload: { state: "open" } },
    {
      kind: "rx",
      payload: { bytesBase64: "AQ==", byteStart: "0", byteEnd: "1" },
    },
    { kind: "tx_intent", payload: tx },
    {
      kind: "tx",
      payload: {
        ...tx,
        sessionId: source.sessionId,
        sessionEpoch: source.sessionEpoch,
        outcome: "accepted",
        acceptedRanges: [{ start: "0", end: "1" }],
        unknownRanges: [],
        peerAcknowledged: false,
      },
    },
    { kind: "gap", payload: { reason: "network_loss", knownExtent: false } },
  ].map((event, index) => {
    const eventSeq = String(index + 1);
    return {
      ...source,
      eventSeq,
      configurationRevision: "1",
      time: {
        clockId: "clock",
        sourceMonoNs: eventSeq,
        receivedWallTime: "2026-11-22T00:00:00Z",
        precision: {
          source: "host_read",
          resolutionNs: "1",
          syncMethod: "fixture",
        },
      },
      ...event,
    };
  });
  const end = {
    after: {
      hostId: source.hostId,
      instanceEpoch: source.instanceEpoch,
      scopeId: "raw:session:7",
      position: "5",
    },
    reason: { kind: "backend_fault", code: "DEVICE_DISCONNECTED" },
    txEvidenceGap: false,
  };
  const exchanges = [];
  const reading = (params) => ({ kind: "session_events", params });
  const success = (result) => ({ ok: true, result });
  const foreignExpiry = expiredScope && expiredScope !== end.after.scopeId;
  if (expiredScope) {
    exchanges.push([
      reading(params),
      {
        ok: false,
        error: {
          code: "CURSOR_EXPIRED",
          message: "Raw history has been evicted",
          details: {
            oldestCursor: {
              ...end.after,
              scopeId: expiredScope,
              position: "2",
            },
          },
        },
      },
    ]);
  }
  if (!foreignExpiry) {
    const retainedStart = expiredScope
      ? { ...params, startEventSeq: "3" }
      : params;
    exchanges.push([
      reading(retainedStart),
      success({
        kind: "session_events",
        events: expiredScope ? events.slice(2) : events,
        nextEventSeq: "6",
        hasMore: true,
      }),
    ]);
    if (!expiredScope)
      exchanges.push([
        next,
        success({
          kind: "stream_read",
          events: [],
          nextEventSeq: "6",
          hasMore: false,
        }),
      ]);
    if (!callbackFails && !cancelPending)
      exchanges.push([
        reading(next),
        success({
          kind: "session_events",
          events: [],
          nextEventSeq: "6",
          hasMore: false,
          end,
        }),
      ]);
  }
  if (!cancelPending)
    exchanges.push([
      { kind: "close_session_events" },
      success({ kind: "session_events_closed" }),
    ]);
  await withBackend(
    t,
    `export function register(context) {
      const seen = [];
      context.queries.register(${JSON.stringify(inspectId)}, () => seen);
      context.actions.register(${JSON.stringify(actionId)}, async (_, task) => {
        try {
          await task.streams.followSession(${JSON.stringify(params)}, {
            onConnect(event) { seen.push("connect:" + event.eventSeq); },
            async onReceive(event) {
              seen.push("receive:start:" + event.eventSeq);
              await task.streams.read(${JSON.stringify(next)});
              seen.push("receive:done:" + event.eventSeq);
              if (${callbackFails}) throw new Error("callback stopped");
            },
            onSend(event) { seen.push("send:" + event.eventSeq + ":" + event.payload.outcome); },
            onError(issue) {
              seen.push("error:" + issue.kind + (issue.oldestCursor ? ":" + issue.oldestCursor.position : ""));
            },
            onDisconnect(end) { seen.push("disconnect:" + end.after.position); },
          });
        } catch (error) {
          if (${cancelPending}) throw error;
          seen.push("caught:" + (error.code ?? error.message));
        }
        return seen;
      });
      return () => {};
    }`,
    async ({ root, entry, send, output }) => {
      for await (const { raw, frame } of output) {
        if (raw) {
          const exchange = exchanges.shift();
          assert.ok(exchange, "unexpected extra Raw exchange");
          const [expected, reply] = exchange;
          assert.deepEqual(frame.params, expected);
          assert.equal(frame.parentRequestId, "2");
          assert.equal(frame.parentOperationId, "parent");
          assert.equal(frame.taskContext, "owned");
          if (cancelPending && expected === next)
            send({ kind: "cancel_action", requestId: "2" });
          send({ requestId: frame.requestId, reply }, rawFlag);
        } else if (frame.kind === "ready") {
          send({ kind: "activate", requestId: "1", id, root, entry });
        } else if (frame.requestId === "1") {
          assert.equal(frame.kind, "registered");
          send({
            kind: "invoke",
            requestId: "2",
            id,
            call: {
              actionId,
              hostId: source.hostId,
              instanceEpoch: source.instanceEpoch,
              target: {
                hostId: source.hostId,
                kind: "session",
                id: source.sessionId,
                sessionId: source.sessionId,
                sessionEpoch: source.sessionEpoch,
              },
            },
            taskContext: "owned",
            parentOperationId: "parent",
          });
        } else if (frame.requestId === "2") {
          assert.equal(
            exchanges.length,
            0,
            "all expected Raw exchanges settled",
          );
          if (cancelPending) {
            assert.equal(frame.kind, "action_cancelled");
            send({
              kind: "query",
              requestId: "3",
              id,
              query: { actionId: inspectId },
            });
            continue;
          }
          assert.equal(frame.kind, "action_completed");
          if (foreignExpiry) {
            assert.deepEqual(frame.value, ["caught:PROTOCOL_ERROR"]);
          } else {
            const first = expiredScope
              ? ["error:cursor_expired:2"]
              : ["connect:1", "receive:start:2", "receive:done:2"];
            const last = callbackFails
              ? ["caught:callback stopped"]
              : [
                  "send:4:accepted",
                  "error:source_gap",
                  "error:backend_fault",
                  "disconnect:5",
                ];
            assert.deepEqual(frame.value, [...first, ...last]);
          }
          return;
        } else if (frame.requestId === "3") {
          assert.equal(cancelPending, true);
          assert.equal(frame.kind, "queried");
          assert.deepEqual(frame.value, ["connect:1", "receive:start:2"]);
          return;
        }
      }
      assert.fail("Node closed before settling session hooks");
    },
  );
}
