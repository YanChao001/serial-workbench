import { expect, it } from "vitest";
import { defaults, type DeviceDescriptor } from "@serial-workbench/contracts";
import {
  addSessionView,
  reconcileWorkspaceTabs,
  copyWorkspace,
  addDeviceView,
  distinctWorkspaceLabels,
  sameWorkspace,
} from "./workspace-model";
import { session } from "./test-fixtures";
const device: DeviceDescriptor = {
  deviceId: "device",
  hostId: "host",
  systemName: "Virtual serial",
  fingerprint: { transport: "virtual", evidence: "unreliable" },
  capabilities: session().capabilities,
};
it("compares document content independently of object key order while preserving array order and real edits", () => {
  const first = addDeviceView(
    defaults.workspace,
    device,
    session().configuration,
    defaults.settings.terminal,
    "#2266AA",
  ).document;
  const second = addDeviceView(
    first,
    device,
    session().configuration,
    defaults.settings.terminal,
    "#2266AA",
  ).document;
  const { bindings, ...rest } = second;
  const reordered = {
    bindings: bindings.map((binding) => {
      const { configuration, ...fields } = binding;
      const { writeWaitMs, ...configurationFields } = configuration;
      return {
        configuration: { writeWaitMs, ...configurationFields },
        ...fields,
      };
    }),
    ...rest,
  };
  expect(sameWorkspace(second, reordered)).toBe(true);
  expect(sameWorkspace(second, { ...second, name: "Changed" })).toBe(false);
  expect(
    sameWorkspace(second, { ...second, views: [...second.views].reverse() }),
  ).toBe(false);
  const unarchived = { ...second };
  delete unarchived.archived;
  expect(
    sameWorkspace(unarchived, { ...unarchived, archived: undefined }),
  ).toBe(true);
  expect(sameWorkspace(second, undefined)).toBe(false);
});
it("adds offline views with distinct names without changing the source document", () => {
  const first = addDeviceView(
    defaults.workspace,
    device,
    session().configuration,
    defaults.settings.terminal,
    "#2266AA",
  );
  const second = addDeviceView(
    first.document,
    device,
    session().configuration,
    defaults.settings.terminal,
    "#2266AA",
  );
  expect(second.document.views.map((view) => view.name)).toEqual([
    "Virtual serial",
    "Virtual serial (2)",
  ]);
  expect(first.document.views).toHaveLength(1);
  expect(defaults.workspace.views).toHaveLength(0);
  expect(second.document.views[1]?.bindingId).toBe(
    second.document.bindings[1]?.bindingId,
  );
});
it("disambiguates existing duplicate labels without rewriting names or colliding with explicit numbered labels", () => {
  const entries = [
    { value: "a", label: "COM5" },
    { value: "b", label: "COM5" },
    { value: "c", label: "COM5 (1)" },
  ];
  const choices = distinctWorkspaceLabels(entries);
  expect(new Set(choices.map((item) => item.label)).size).toBe(3);
  expect(choices.map((item) => item.value)).toEqual(["a", "b", "c"]);
  expect(entries.map((item) => item.label)).toEqual([
    "COM5",
    "COM5",
    "COM5 (1)",
  ]);
});
it("copies presets with independent view and binding identities while preserving favorite references", () => {
  const source = addSessionView(
    defaults.workspace,
    session(),
    device,
    defaults.settings.terminal,
    "#2266AA",
  )!.document;
  source.favoriteBindingIds = [source.bindings[0]!.bindingId];
  const snapshot = structuredClone(source);
  const copy = copyWorkspace(source, "Independent bench");
  expect(copy.name).toBe("Independent bench");
  expect(copy.views[0]!.id).not.toBe(source.views[0]!.id);
  expect(copy.bindings[0]!.bindingId).not.toBe(source.bindings[0]!.bindingId);
  expect(copy.views[0]!.bindingId).toBe(copy.bindings[0]!.bindingId);
  expect(copy.favoriteBindingIds).toEqual([copy.bindings[0]!.bindingId]);
  expect(copy.bindings[0]!.configuration).toEqual(
    source.bindings[0]!.configuration,
  );
  expect(source).toEqual(snapshot);
});
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
