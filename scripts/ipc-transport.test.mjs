import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  new URL("../src-tauri/src/ipc-transport.js", import.meta.url),
  "utf8",
);
function fixture(postMessage) {
  const messages = [];
  let fetches = 0;
  const window = {
    __TAURI_INTERNALS__: {},
    ipc: {
      postMessage(data) {
        const message = JSON.parse(data);
        messages.push(message);
        postMessage?.(message);
      },
    },
  };
  runInNewContext(source.replaceAll("__INVOKE_KEY__", '"fixture-invoke-key"'), {
    window,
    ArrayBuffer,
    Uint8Array,
    Map,
    fetch() {
      fetches++;
      return Promise.reject(new TypeError("Navigation cancelled the reply"));
    },
  });
  return {
    send: window.__TAURI_INTERNALS__.postMessage,
    messages,
    fetches: () => fetches,
  };
}
const command = (payload = {}) => ({
  cmd: "host_subscribe",
  callback: 11,
  error: 12,
  payload,
});

test("Native dispatch has one acceptance path when navigation could cancel a fetch reply", async () => {
  const f = fixture();
  f.send(
    command({ request: { requestId: "request" }, channel: "__CHANNEL__:42" }),
  );
  await setImmediate();
  assert.equal(f.messages.length, 1);
  assert.equal(f.fetches(), 0);
  assert.equal(f.messages[0].payload.channel, "__CHANNEL__:42");
});

test("postMessage retains Tauri authentication, callbacks, headers and serialization", () => {
  const f = fixture();
  const message = command({
    bytes: new Uint8Array([0, 127, 255]),
    buffer: new Uint8Array([1, 2]).buffer,
    map: new Map([["entry", 3]]),
    channel: { __TAURI_TO_IPC_KEY__: () => "__CHANNEL__:42" },
  });
  f.send({ ...message, options: { headers: { "fixture-header": "value" } } });
  assert.deepEqual(f.messages, [
    {
      ...message,
      payload: {
        bytes: [0, 127, 255],
        buffer: [1, 2],
        map: { entry: 3 },
        channel: "__CHANNEL__:42",
      },
      options: {
        headers: { "fixture-header": "value" },
        customProtocolIpcBlocked: true,
      },
      __TAURI_INVOKE_KEY__: "fixture-invoke-key",
    },
  ]);
  assert.equal(f.send.toString().includes("fixture-invoke-key"), false);
});

test("separate explicit Native calls are each dispatched once", () => {
  const f = fixture();
  f.send(command({ requestId: "first" }));
  f.send(command({ requestId: "second" }));
  assert.deepEqual(
    f.messages.map((message) => message.payload.requestId),
    ["first", "second"],
  );
});

test("a dispatch error after acceptance is surfaced without replay", async () => {
  const failure = new Error("Accepted before the transport reported an error");
  const f = fixture(() => {
    throw failure;
  });
  assert.throws(
    () => f.send(command()),
    (error) => error === failure,
  );
  await setImmediate();
  assert.equal(f.messages.length, 1);
  assert.equal(f.fetches(), 0);
});
