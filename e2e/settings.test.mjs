import assert from "node:assert/strict";
import test from "node:test";
import { _setGlobal } from "@wdio/globals";
import { hostQuery, patchSettings, readSettings } from "./settings.mjs";

function fixture(t) {
  const calls = [];
  const attachment = {
    protocolVersion: "1",
    hostId: "host:test",
    instanceEpoch: "3",
    actorId: "actor:test",
  };
  const generation = "17";
  let shared = {
    document: {
      revision: "7",
      value: { language: "en", theme: "dark" },
    },
  };
  const client = {
    revision: "11",
    state: {
      preferences: {
        menuBar: true,
        windowPosition: "remember",
        sidebarCollapsed: true,
        sidebarWidth: 240,
        receiveHistory: { maxRecords: 2000, maxBytes: 8388608 },
      },
    },
  };
  const originalNative = Object.getOwnPropertyDescriptor(
    globalThis,
    "__TAURI_INTERNALS__",
  );
  const globals = globalThis._wdioGlobals;
  const hadBrowser = globals.has("browser");
  const originalBrowser = globals.get("browser");
  _setGlobal(
    "browser",
    {
      execute: async (script, ...args) => script(...args),
      waitUntil: async (condition) => {
        assert.equal(await condition(), true, "Fixture operation must settle");
      },
    },
    false,
  );
  Object.defineProperty(globalThis, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command, args) => {
        calls.push({ command, args: structuredClone(args) });
        if (command === "host_attachment") return { attachment, generation };
        if (command === "client_state_read") return structuredClone(client);
        if (command === "host_request") {
          const query = args.request.params;
          if (query.actionId === "settings.read")
            return {
              ok: true,
              result: { kind: "settings", value: structuredClone(shared) },
            };
          return { ok: true, result: { kind: "query-result" } };
        }
        if (command === "host_apply_document_intent") {
          shared = {
            document: {
              revision: "8",
              value: structuredClone(args.intent.params.value),
            },
          };
          return { state: "succeeded", result: { kind: "settings" } };
        }
        throw new Error(`Unexpected native command: ${command}`);
      },
    },
  });
  t.after(() => {
    if (originalNative)
      Object.defineProperty(globalThis, "__TAURI_INTERNALS__", originalNative);
    else delete globalThis.__TAURI_INTERNALS__;
    if (hadBrowser) _setGlobal("browser", originalBrowser, false);
    else globals.delete("browser");
  });
  return { calls, attachment, generation, client };
}

test("host queries submit the generation observed with their attachment", async (t) => {
  const f = fixture(t);
  const observations = [];
  const result = await hostQuery(
    "workspace.read",
    "workspace",
    "workspace:test",
    { includeViews: true },
    (value) => observations.push(value),
  );
  assert.deepEqual(result, { kind: "query-result" });
  const requests = f.calls.filter((call) => call.command === "host_request");
  assert.equal(requests.length, 1);
  const { generation, request } = requests[0].args;
  assert.equal(generation, f.generation);
  assert.equal(request.method, "action.query");
  assert.match(request.params.requestId, /^[\da-f-]{36}$/i);
  assert.deepEqual(request.params, {
    ...f.attachment,
    requestId: request.params.requestId,
    actionId: "workspace.read",
    target: {
      hostId: f.attachment.hostId,
      kind: "workspace",
      id: "workspace:test",
    },
    params: { includeViews: true },
    revealTarget: { pageId: "settings" },
  });
  assert.deepEqual(
    observations.map(({ phase, generation }) => ({ phase, generation })),
    [
      { phase: "attachment_observed", generation: f.generation },
      { phase: "query_replied", generation: f.generation },
    ],
  );
});

test("restoring combined settings keeps unchanged client history out of the shared intent", async (t) => {
  const f = fixture(t);
  const original = await readSettings();
  const receiveHistory = structuredClone(original.settings.receiveHistory);
  const restored = await patchSettings({
    ...original.settings,
    theme: "light",
    receiveHistory,
  });
  assert.notEqual(receiveHistory, original.settings.receiveHistory);
  assert.equal(
    f.calls.filter((call) => call.command === "client_state_save").length,
    0,
    "Equal client preferences must not trigger a native save or reload",
  );
  const intents = f.calls.filter(
    (call) => call.command === "host_apply_document_intent",
  );
  assert.equal(intents.length, 1);
  assert.deepEqual(intents[0].args, {
    generation: f.generation,
    intent: {
      kind: "settingsSave",
      expectedRevision: "7",
      params: { value: { language: "en", theme: "light" } },
    },
  });
  assert.equal(restored.settings.theme, "light");
  assert.deepEqual(
    restored.settings.receiveHistory,
    f.client.state.preferences.receiveHistory,
  );
});
