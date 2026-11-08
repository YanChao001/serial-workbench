import { expect, it } from "vitest";
import { defaults, type DeviceDescriptor } from "@serial-workbench/contracts";
import { addSessionView, reconcileWorkspaceTabs } from "./workspace-model";
import { session } from "./test-fixtures";
const device: DeviceDescriptor = {
  deviceId: "device",
  hostId: "host",
  systemName: "Virtual serial",
  fingerprint: { transport: "virtual", evidence: "unreliable" },
  capabilities: session().capabilities,
};
it("records an explicitly opened view as configuration without copying client drafts", () => {
  const result = addSessionView(
    defaults.workspace,
    session(),
    device,
    defaults.settings.terminal,
    defaults.settings.customAccent,
  );
  expect(result?.document.views).toHaveLength(1);
  expect(result?.document.bindings[0]).toMatchObject({
    deviceId: "device",
    hostId: "host",
    configuration: session().configuration,
    reconnect: { enabled: false },
  });
  expect(result?.document.views[0]).toMatchObject({
    name: "Virtual serial",
    receiveMode: defaults.settings.terminal.receiveMode,
    sendMode: defaults.settings.terminal.sendMode,
  });
  expect(result?.document).not.toHaveProperty("drafts");
});
it("acknowledged view changes preserve the same session only for the same exact binding", () => {
  const first = addSessionView(
    defaults.workspace,
    session(),
    device,
    defaults.settings.terminal,
    defaults.settings.customAccent,
  )!;
  const view = first.document.views[0]!;
  const tabs = [{ id: view.id, view, sessionId: "session" }];
  const renamed = { ...first.document, views: [{ ...view, name: "Named" }] };
  expect(
    reconcileWorkspaceTabs(tabs, first.document, renamed)[0],
  ).toMatchObject({ sessionId: "session", view: { name: "Named" } });
  const rebound = {
    ...renamed,
    bindings: renamed.bindings.map((binding) => ({
      ...binding,
      deviceId: "different-device",
    })),
  };
  expect(
    reconcileWorkspaceTabs(tabs, first.document, rebound)[0]?.sessionId,
  ).toBeUndefined();
  expect(
    reconcileWorkspaceTabs(tabs, first.document, { ...renamed, views: [] }),
  ).toEqual([]);
});
