import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { invoke, ready } from "./helpers.mjs";

export async function nativeValue(command, args, onFailure) {
  const reply = await invoke(command, args);
  if (!reply.ok) onFailure?.(reply.failure);
  assert.equal(reply.ok, true, `${command}: ${JSON.stringify(reply.failure)}`);
  return reply.value;
}

export async function hostQuery(actionId, kind, id, params = {}, observed) {
  const { attachment, generation } = await nativeValue(
    "host_attachment",
    {},
    (failure) =>
      observed?.({ phase: "attachment_failed", errorCode: failure?.code }),
  );
  observed?.({ phase: "attachment_observed", generation });
  const requestId = await browser.execute(() => crypto.randomUUID());
  const reply = await nativeValue(
    "host_request",
    {
      request: {
        method: "action.query",
        params: {
          protocolVersion: attachment.protocolVersion,
          hostId: attachment.hostId,
          instanceEpoch: attachment.instanceEpoch,
          actorId: attachment.actorId,
          requestId,
          actionId,
          target: {
            hostId: attachment.hostId,
            kind,
            id: id ?? attachment.hostId,
          },
          params,
          revealTarget: { pageId: "settings" },
        },
      },
    },
    (failure) =>
      observed?.({
        phase: "query_failed",
        generation,
        errorCode: failure?.code,
      }),
  );
  observed?.({
    phase: reply.ok ? "query_replied" : "query_failed",
    generation,
    errorCode: reply.error?.code,
  });
  assert.equal(reply.ok, true, `${actionId}: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

export async function readSettings(observed) {
  const [shared, client] = await Promise.all([
    hostQuery("settings.read", "settings", "shared", {}, observed),
    nativeValue("client_state_read"),
  ]);
  assert.equal(shared.kind, "settings");
  assert.equal(typeof shared.value.document.revision, "string");
  assert.equal(typeof client.revision, "string");
  return {
    shared: shared.value,
    client,
    revision: shared.value.document.revision,
    settings: { ...shared.value.document.value, ...client.state.preferences },
  };
}

export async function patchSettings(patch) {
  const clientKeys = [
    "menuBar",
    "windowPosition",
    "sidebarCollapsed",
    "sidebarWidth",
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await readSettings();
    const clientPatch = Object.fromEntries(
      Object.entries(patch).filter(
        ([key, value]) =>
          clientKeys.includes(key) &&
          snapshot.client.state.preferences[key] !== value,
      ),
    );
    const sharedPatch = Object.fromEntries(
      Object.entries(patch).filter(([key]) => !clientKeys.includes(key)),
    );
    if (Object.keys(clientPatch).length) {
      const reply = await invoke("client_state_save", {
        state: {
          ...snapshot.client.state,
          preferences: { ...snapshot.client.state.preferences, ...clientPatch },
        },
        expectedRevision: snapshot.client.revision,
      });
      if (!reply.ok && reply.failure?.code === "CONFLICT") continue;
      assert.equal(reply.ok, true, JSON.stringify(reply.failure));
      const label = await browser.execute(
        () => window.__TAURI__.window.getCurrentWindow().label,
      );
      // ClientState 按窗口读取；直接写入后重新加载真实 Provider，不伪造同步事件。
      await browser.refresh();
      await ready(label);
    }
    if (!Object.keys(sharedPatch).length) return readSettings();
    const { generation } = await nativeValue("host_attachment");
    const reply = await invoke("host_apply_document_intent", {
      generation,
      intent: {
        kind: "settingsSave",
        expectedRevision: snapshot.revision,
        params: {
          value: { ...snapshot.shared.document.value, ...sharedPatch },
        },
      },
    });
    if (!reply.ok && reply.failure?.code === "REVISION_CONFLICT") continue;
    assert.equal(reply.ok, true, JSON.stringify(reply.failure));
    let operation = reply.value;
    await browser.waitUntil(async () => {
      if (!["queued", "running", "cancel_requested"].includes(operation.state))
        return true;
      const result = await hostQuery("operation.get", "host", undefined, {
        operationId: operation.operationId,
      });
      assert.equal(result.kind, "operation");
      operation = result.value.operation;
      return !["queued", "running", "cancel_requested"].includes(
        operation.state,
      );
    });
    if (operation.error?.code === "REVISION_CONFLICT") continue;
    assert.equal(operation.state, "succeeded", JSON.stringify(operation.error));
    assert.equal(operation.result?.kind, "settings");
    return readSettings();
  }
  throw new Error("Settings CAS did not settle");
}
