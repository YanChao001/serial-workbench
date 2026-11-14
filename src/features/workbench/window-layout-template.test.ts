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
  const encoded = snapshotWindowLayout(
    result,
    [{ id: "first", view: result.views[0] }],
    [current],
    [device],
    defaults.settings.terminal,
    {
      first: { receiveEncoding: null, sendEncoding: "gbk" },
    },
  );
  expect(encoded.views[0]?.receiveEncoding).toBeNull();
  expect(encoded.views[0]?.sendEncoding).toBe("gbk");
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
it("retains runtime views in a saved layout after their closed session metadata has been pruned", () => {
  const source = {
    session: session(),
    device: {
      hostId: "host",
      deviceId: "device",
      systemName: "COM5",
      fingerprint: {
        transport: "virtual" as const,
        evidence: "unreliable" as const,
      },
      capabilities: session().capabilities,
    },
  };
  const result = snapshotWindowLayout(
    defaults.workspace,
    [
      { id: "first", sessionId: "session", source },
      { id: "second", sessionId: "session", source },
    ],
    [],
    [],
    defaults.settings.terminal,
    {},
  );
  expect(result.views.map((view) => view.id)).toEqual(["first", "second"]);
  expect(result.bindings).toHaveLength(1);
  expect(result.bindings[0]).toMatchObject({
    hostId: "host",
    deviceId: "device",
    configuration: source.session.configuration,
  });
  const foreign = snapshotWindowLayout(
    defaults.workspace,
    [{ id: "retained", sessionId: "session", source }],
    [
      {
        ...source.session,
        configuration: { ...source.session.configuration, baudRate: "921600" },
      },
    ],
    [{ ...source.device, hostId: "other-host" }],
    defaults.settings.terminal,
    {},
  );
  expect(foreign.bindings[0]).toMatchObject({
    hostId: "host",
    configuration: source.session.configuration,
  });
});
it("saves an explicitly rebound view without rebinding sibling views or their favorite preset", () => {
  const current = session();
  const binding = {
    bindingId: "previous-binding",
    hostId: "retired-host",
    deviceId: "retired-device",
    fingerprint: {
      transport: "serial" as const,
      evidence: "unreliable" as const,
    },
    configuration: defaults.serialConfiguration,
    reconnect: { enabled: false, maxDelayMs: "1000", maxAttempts: "3" },
  };
  const view = {
    id: "rebound",
    name: "My controller",
    bindingId: binding.bindingId,
    color: "#2266aa",
    icon: "cpu",
    pinned: true,
    receiveMode: "hex" as const,
    sendMode: "text" as const,
  };
  const sibling = { ...view, id: "offline-sibling" };
  const base = {
    ...defaults.workspace,
    bindings: [binding],
    views: [view, sibling],
    favoriteBindingIds: [binding.bindingId],
  };
  const original = structuredClone(base);
  const device = {
    hostId: "host",
    deviceId: "device",
    systemName: "COM5",
    fingerprint: {
      transport: "virtual" as const,
      evidence: "unreliable" as const,
    },
    capabilities: current.capabilities,
  };
  const result = snapshotWindowLayout(
    base,
    [
      { id: view.id, view, sessionId: current.sessionId },
      { id: sibling.id, view: sibling },
    ],
    [current],
    [device],
    defaults.settings.terminal,
    {},
  );
  expect(result.views[0]).toMatchObject({
    ...view,
    bindingId: expect.any(String),
  });
  expect(result.views[0]?.bindingId).not.toBe(binding.bindingId);
  expect(
    result.bindings.find(
      (item) => item.bindingId === result.views[0]?.bindingId,
    ),
  ).toMatchObject({
    hostId: device.hostId,
    deviceId: device.deviceId,
    fingerprint: device.fingerprint,
    configuration: current.configuration,
  });
  expect(result.views[1]).toEqual(sibling);
  expect(result.bindings[0]).toEqual(binding);
  expect(result.favoriteBindingIds).toEqual(base.favoriteBindingIds);
  expect(base).toEqual(original);
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
  const edited = {
    ...base,
    bindings: [
      {
        ...binding,
        configuration: { ...binding.configuration, baudRate: "9600" },
      },
    ],
  };
  const preset = snapshotWindowLayout(
    edited,
    [{ id: "saved", view, sessionId: "session" }],
    [current],
    [device],
    defaults.settings.terminal,
    {},
    defaults.settings.customAccent,
    true,
  );
  expect(preset.bindings[0]?.configuration.baudRate).toBe("9600");
  expect(base.bindings[0]?.configuration.baudRate).toBe(
    defaults.serialConfiguration.baudRate,
  );
});
