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

test("a cancelled Raw reply aborts the task before the control frame arrives", async (t) => {
  const parent = join(project, ".cache/script-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "raw-cancel-"));
  t.after(() => {
    if (t.passed) removeProjectPath(project, relative(project, root));
  });
  const entry = join(root, "fixture.mjs");
  const actionId = "example.cancel.test";
  writeFileSync(
    entry,
    `export function register({ actions }) {
      actions.register(${JSON.stringify(actionId)}, (_, task) => task.streams.read({}));
      return () => {};
    }`,
  );
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
  let rawReplySent = false;
  try {
    send(readFileSync(join(backend, "bootstrap.mjs")));
    for await (const { raw, frame } of frames(child.stdout)) {
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
    assert.fail(
      pipeError?.message ?? "Node closed before reporting cancellation",
    );
  } finally {
    clearTimeout(timeout);
    child.kill();
    await exited;
  }
});
