import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { Worker } from "node:worker_threads";

const entry = new URL(
  "../crates/host/src/node_backend/script-worker.mjs",
  import.meta.url,
);

function approve(language, source) {
  return createHash("sha256")
    .update("serial-workbench-script-v1\0")
    .update(language)
    .update("\0")
    .update(source, "utf8")
    .digest("hex");
}

test("a confirmed TypeScript file waits and returns a log and result", async (t) => {
  const source = `
    export default async function run({ delay, log }: {
      delay(ms: number): Promise<void>;
      log(message: string): void;
    }) {
      await delay(1);
      log("script ready");
      return { bytes: [0, 255] };
    }
  `;
  const worker = new Worker(entry, {
    workerData: { language: "ts", source, sourceSha256: approve("ts", source) },
  });
  t.after(() => worker.terminate());
  const exited = once(worker, "exit");
  const [result] = await once(worker, "message");
  assert.deepEqual(result, {
    kind: "completed",
    logs: ["script ready"],
    value: { bytes: [0, 255] },
  });
  assert.deepEqual(await exited, [0]);
});

test("a script changed after confirmation fails before its module is loaded", async (t) => {
  const confirmed = "export default () => null;";
  const source =
    "throw new Error('must never execute'); export default () => null;";
  const worker = new Worker(entry, {
    workerData: {
      language: "js",
      source,
      sourceSha256: approve("js", confirmed),
    },
  });
  t.after(() => worker.terminate());
  const exited = once(worker, "exit");
  const [result] = await once(worker, "message");
  assert.deepEqual(result, {
    kind: "failed",
    code: "SCRIPT_SOURCE_CHANGED",
    message: "Script source differs from the confirmed snapshot",
  });
  assert.deepEqual(await exited, [0]);
});

test("script sends exact bytes and reads the bound session through the task bridge", async (t) => {
  const source = `
    export default async function run({ serial, log }) {
      const rx = await serial.read("17");
      const tx = await serial.send(new Uint8Array([0, 255]));
      log(rx.nextEventSeq);
      return tx.operationId;
    }
  `;
  const worker = new Worker(entry, {
    workerData: { language: "js", source, sourceSha256: approve("js", source) },
  });
  t.after(() => worker.terminate());
  const exited = once(worker, "exit");
  const [read] = await once(worker, "message");
  assert.deepEqual(read, { kind: "serial-read", id: 1, startEventSeq: "17" });
  const writing = once(worker, "message");
  worker.postMessage({
    kind: "serial-result",
    id: 1,
    ok: true,
    value: { events: [], nextEventSeq: "18" },
  });
  assert.deepEqual(await writing, [
    { kind: "serial-send", id: 2, bytesBase64: "AP8=" },
  ]);
  const completed = once(worker, "message");
  worker.postMessage({
    kind: "serial-result",
    id: 2,
    ok: true,
    value: { operationId: "tx-1", outcome: "accepted" },
  });
  assert.deepEqual(await completed, [
    { kind: "completed", logs: ["18"], value: "tx-1" },
  ]);
  assert.deepEqual(await exited, [0]);
});

test("a failed serial operation reaches the script with the bridge error", async (t) => {
  const source = "export default ({ serial }) => serial.read('19');";
  const worker = new Worker(entry, {
    workerData: { language: "js", source, sourceSha256: approve("js", source) },
  });
  t.after(() => worker.terminate());
  const exited = once(worker, "exit");
  assert.deepEqual(await once(worker, "message"), [
    { kind: "serial-read", id: 1, startEventSeq: "19" },
  ]);
  const completed = once(worker, "message");
  worker.postMessage({
    kind: "serial-result",
    id: 1,
    ok: false,
    message: "Session epoch changed",
  });
  assert.deepEqual(await completed, [
    {
      kind: "failed",
      code: "SCRIPT_SERIAL_FAILED",
      message: "Session epoch changed",
    },
  ]);
  assert.deepEqual(await exited, [0]);
});
