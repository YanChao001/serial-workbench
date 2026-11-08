import { expect, it } from "vitest";
import { defaults } from "@serial-workbench/contracts";
import { session } from "./test-fixtures";
import { snapshotWindowLayout } from "./window-layout-template";

it("snapshots only current window tabs and modes without changing the saved template", () => {
  const document = { ...defaults.workspace, name: "Bench" };
  const current = session();
  const device = {
    deviceId: "device",
    hostId: "host",
    systemName: "Virtual serial",
    fingerprint: {
      transport: "virtual" as const,
      evidence: "unreliable" as const,
    },
    capabilities: current.capabilities,
  };
  const result = snapshotWindowLayout(
    document,
    [
      { id: "first", sessionId: "session" },
      { id: "second", sessionId: "session" },
    ],
    [current],
    [device],
    defaults.settings.terminal,
    { first: { receiveMode: "hex" }, second: { sendMode: "hex" } },
  );
  expect(document.views).toEqual([]);
  expect(
    result.views.map((view) => ({
      id: view.id,
      receiveMode: view.receiveMode,
      sendMode: view.sendMode,
    })),
  ).toEqual([
    { id: "first", receiveMode: "hex", sendMode: "text" },
    { id: "second", receiveMode: "text", sendMode: "hex" },
  ]);
  expect(result.bindings).toHaveLength(1);
  expect(result.views[0]?.bindingId).toBe(result.views[1]?.bindingId);
  expect(result.bindings[0]).toEqual(
    expect.objectContaining({
      hostId: "host",
      deviceId: "device",
      configuration: current.configuration,
    }),
  );
  const closed = snapshotWindowLayout(
    result,
    [{ id: "second", view: result.views[1] }],
    [current],
    [device],
    defaults.settings.terminal,
    {},
  );
  expect(closed.views.map((view) => view.id)).toEqual(["second"]);
  expect(result.views).toHaveLength(2);
});
it("retains an unresolved saved view and its binding without inventing an online device", () => {
  const binding = {
    bindingId: "saved-binding",
    hostId: "other-host",
    deviceId: "missing-device",
    fingerprint: {
      transport: "serial" as const,
      evidence: "unreliable" as const,
    },
    configuration: defaults.serialConfiguration,
    reconnect: { enabled: false, maxDelayMs: "1000", maxAttempts: "3" },
  };
  const view = {
    id: "saved",
    name: "Offline controller",
    bindingId: "saved-binding",
    color: "#2266aa",
    icon: "terminal",
    pinned: true,
    receiveMode: "hex" as const,
    sendMode: "text" as const,
  };
  const document = {
    ...defaults.workspace,
    bindings: [binding],
    views: [view],
    favoriteBindingIds: [binding.bindingId],
  };
  expect(
    snapshotWindowLayout(
      document,
      [{ id: "saved", view }],
      [],
      [],
      defaults.settings.terminal,
      {},
    ),
  ).toEqual(document);
});
it("saves the real current serial configuration of an attached saved view", () => {
  const current = {
    ...session(),
    configuration: { ...session().configuration, baudRate: "230400" },
  };
  const binding = {
    bindingId: "saved-binding",
    hostId: "host",
    deviceId: "device",
    fingerprint: {
      transport: "virtual" as const,
      evidence: "unreliable" as const,
    },
    configuration: defaults.serialConfiguration,
    reconnect: { enabled: false, maxDelayMs: "1000", maxAttempts: "3" },
  };
  const view = {
    id: "saved",
    name: "Controller",
    bindingId: "saved-binding",
    color: "#2266aa",
    icon: "terminal",
    pinned: false,
    receiveMode: "text" as const,
    sendMode: "text" as const,
  };
  const base = { ...defaults.workspace, views: [view], bindings: [binding] };
  const device = {
    hostId: "host",
    deviceId: "device",
    systemName: "Virtual",
    fingerprint: binding.fingerprint,
    capabilities: current.capabilities,
  };
  const result = snapshotWindowLayout(
    base,
    [{ id: "saved", view, sessionId: "session" }],
    [current],
    [device],
    defaults.settings.terminal,
    {},
  );
  expect(result.bindings[0]?.configuration.baudRate).toBe("230400");
  expect(base.bindings[0]?.configuration.baudRate).toBe(
    defaults.serialConfiguration.baudRate,
  );
});
