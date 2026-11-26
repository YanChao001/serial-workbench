import assert from "node:assert/strict";
import test from "node:test";
import { _setGlobal } from "@wdio/globals";
import { globalSendRawReader } from "./global-send.mjs";

test("the global send reader consumes the flat Raw RPC page after the exact source tail", async (t) => {
  const attachment = {
    protocolVersion: "1.0",
    hostId: "test-host",
    instanceEpoch: "3",
    actorId: "test-actor",
  };
  const target = {
    kind: "session",
    id: "echo-session",
    hostId: attachment.hostId,
    sessionId: "echo-session",
    sessionEpoch: "7",
  };
  const page = {
    events: [
      { ...target, instanceEpoch: attachment.instanceEpoch, kind: "rx" },
    ],
    nextEventSeq: "9007199254740995",
    hasMore: false,
  };
  const requests = [];
  const native = {
    async invoke(command, args) {
      if (command === "host_attachment") return { attachment, generation: "9" };
      const { request, generation } = args;
      requests.push({ command, generation, request });
      switch (request.params.actionId) {
        case "state.scopes":
          return {
            ok: true,
            result: {
              kind: "scopes",
              value: { scopes: [{ scopeId: `session:${target.id}`, target }] },
            },
          };
        case "session.get":
          return {
            ok: true,
            result: {
              kind: "session",
              value: { ...target, deviceId: "virtual:echo", state: "open" },
            },
          };
        case "stream.cursor":
          return {
            ok: true,
            result: {
              kind: "stream_cursor",
              value: {
                target,
                cursor: { ...attachment, position: "9007199254740993" },
              },
            },
          };
        case "stream.read":
          return { ok: true, result: page };
        default:
          throw new Error(`Unexpected request ${request.params.actionId}`);
      }
    },
  };
  const savedNative = Object.getOwnPropertyDescriptor(
    globalThis,
    "__TAURI_INTERNALS__",
  );
  const globals = globalThis._wdioGlobals;
  const hadBrowser = globals.has("browser");
  const savedBrowser = globals.get("browser");
  _setGlobal(
    "browser",
    { execute: (callback, ...args) => callback(...args) },
    false,
  );
  Object.defineProperty(globalThis, "__TAURI_INTERNALS__", {
    configurable: true,
    value: native,
  });
  t.after(() => {
    if (savedNative)
      Object.defineProperty(globalThis, "__TAURI_INTERNALS__", savedNative);
    else delete globalThis.__TAURI_INTERNALS__;
    if (hadBrowser) _setGlobal("browser", savedBrowser, false);
    else globals.delete("browser");
  });

  const read = await globalSendRawReader();
  assert.deepEqual(await read(), page);
  const last = requests.at(-1);
  assert.equal(last.command, "host_raw_request");
  assert.equal(last.generation, "9");
  assert.equal(last.request.method, "stream.read");
  assert.deepEqual(last.request.params.target, target);
  assert.equal(last.request.params.params.startEventSeq, "9007199254740994");
});
