import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    send(readFileSync(join(backend, "bootstrap.mjs")));
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
