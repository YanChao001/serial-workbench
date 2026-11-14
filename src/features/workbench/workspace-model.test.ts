import { expect, it } from "vitest";
import { defaults, type DeviceDescriptor } from "@serial-workbench/contracts";
import {
  addSessionView,
  reconcileWorkspaceTabs,
  copyWorkspace,
  addDeviceView,
  distinctWorkspaceLabels,
  enrichWorkspacePorts,
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

const currentPort: DeviceDescriptor = {
  ...device,
  deviceId: "current-device",
  systemName: "COM5",
  fingerprint: { transport: "serial", evidence: "unreliable" },
};

function legacyPortWorkspace() {
  const document = addDeviceView(
    defaults.workspace,
    { ...currentPort, deviceId: "old-device" },
    session().configuration,
    defaults.settings.terminal,
    "#2266AA",
  ).document;
  Reflect.deleteProperty(document.bindings[0]!, "portName");
  return document;
}

it("enriches a legacy offline workspace with its uniquely available named port without changing identity or configuration", () => {
  const document = legacyPortWorkspace();
  document.favoriteBindingIds = [document.bindings[0]!.bindingId];
  const original = structuredClone(document);

  const enriched = enrichWorkspacePorts(document, [currentPort]);

  expect(enriched).not.toBe(document);
  expect(enriched.bindings).toEqual([
    { ...original.bindings[0], portName: "COM5" },
  ]);
  expect(enriched.views).toBe(document.views);
  expect(enriched.favoriteBindingIds).toBe(document.favoriteBindingIds);
  expect(document).toEqual(original);
});

it("uses a previous view name only when a renamed view no longer identifies an available port", () => {
  const previous = legacyPortWorkspace();
  const renamed = {
    ...previous,
    views: previous.views.map((view) => ({ ...view, name: "Controller" })),
  };
  expect(enrichWorkspacePorts(renamed, [currentPort])).toBe(renamed);

  const enriched = enrichWorkspacePorts(
    renamed,
    [currentPort],
    false,
    previous,
  );
  expect(enriched.bindings[0]).toEqual({
    ...previous.bindings[0],
    portName: "COM5",
  });
  expect(enriched.views).toBe(renamed.views);
  expect(previous.bindings[0]).not.toHaveProperty("portName");

  const otherPort = {
    ...currentPort,
    deviceId: "other-port",
    systemName: "COM3",
  };
  const newlyNamed = {
    ...renamed,
    views: renamed.views.map((view) => ({ ...view, name: "COM3" })),
  };
  expect(
    enrichWorkspacePorts(newlyNamed, [currentPort, otherPort], false, previous)
      .bindings[0],
  ).toHaveProperty("portName", "COM3");
});

it("does not guess between conflicting associated view names or use an unrelated previous binding", () => {
  const previous = legacyPortWorkspace();
  const view = previous.views[0]!;
  const conflicting = {
    ...previous,
    views: [view, { ...view, id: "second-view", name: "COM3" }],
  };
  const otherPort = {
    ...currentPort,
    deviceId: "other-port",
    systemName: "COM3",
  };
  expect(
    enrichWorkspacePorts(
      conflicting,
      [currentPort, otherPort],
      false,
      previous,
    ),
  ).toBe(conflicting);

  const renamed = {
    ...previous,
    views: [{ ...view, name: "Controller" }],
  };
  const unrelatedPrevious = {
    ...previous,
    views: [{ ...view, bindingId: "another-binding" }],
  };
  expect(
    enrichWorkspacePorts(renamed, [currentPort], false, unrelatedPrevious),
  ).toBe(renamed);
});

it("does not borrow a previous view name after a binding identity changes", () => {
  const previous = legacyPortWorkspace();
  const saved = previous.bindings[0]!;
  for (const binding of [
    { ...saved, hostId: "another-host" },
    { ...saved, deviceId: "another-identity" },
    { ...saved, fingerprint: { ...saved.fingerprint, vid: 1234 } },
  ]) {
    const rebound = {
      ...previous,
      bindings: [binding],
      views: previous.views.map((view) => ({ ...view, name: "Controller" })),
    };
    expect(
      enrichWorkspacePorts(
        rebound,
        [{ ...currentPort, hostId: binding.hostId }],
        false,
        previous,
      ),
    ).toBe(rebound);
  }
});

it("keeps the original document when no named port is currently available", () => {
  const document = legacyPortWorkspace();
  expect(enrichWorkspacePorts(document, [])).toBe(document);
  expect(document.bindings[0]).not.toHaveProperty("portName");
});

it("keeps explicit port hints ahead of display names and retains references when nothing changes", () => {
  const document = legacyPortWorkspace();
  document.bindings[0]!.portName = "COM3";
  const otherPort = {
    ...currentPort,
    deviceId: "other-port",
    systemName: "COM3",
  };
  expect(enrichWorkspacePorts(document, [currentPort, otherPort])).toBe(
    document,
  );
  expect(enrichWorkspacePorts(document, [currentPort])).toBe(document);

  document.bindings[0]!.deviceId = currentPort.deviceId;
  const updated = enrichWorkspacePorts(document, [currentPort]);
  expect(updated.bindings[0]).toEqual({
    ...document.bindings[0],
    portName: "COM5",
  });
  expect(enrichWorkspacePorts(updated, [currentPort])).toBe(updated);
});

it.each([
  { name: "stale devices", devices: [currentPort], stale: true },
  {
    name: "another Host",
    devices: [{ ...currentPort, hostId: "another-host" }],
    stale: false,
  },
  {
    name: "ambiguous port names",
    devices: [currentPort, { ...currentPort, deviceId: "duplicate-port" }],
    stale: false,
  },
])(
  "does not enrich an unconfirmed legacy binding from $name",
  ({ devices, stale }) => {
    const document = legacyPortWorkspace();
    expect(enrichWorkspacePorts(document, devices, stale)).toBe(document);
  },
);

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
  expect(second.document.bindings).toEqual([
    expect.objectContaining({ portName: "Virtual serial" }),
    expect.objectContaining({ portName: "Virtual serial" }),
  ]);
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
  source.views[0]!.name = "User controller name";
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
  expect(copy.bindings[0]).toMatchObject({ portName: "Virtual serial" });
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
    portName: "Virtual serial",
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
it("does not invent a port hint when copying an older binding without one", () => {
  const source = addDeviceView(
    defaults.workspace,
    device,
    session().configuration,
    defaults.settings.terminal,
    "#2266AA",
  ).document;
  Reflect.deleteProperty(source.bindings[0]!, "portName");
  source.views[0]!.name = "A custom view name";
  const original = structuredClone(source);
  const copy = copyWorkspace(source, "Saved as another workspace");
  expect(copy.bindings[0]).not.toHaveProperty("portName");
  expect(copy.views[0]?.name).toBe("A custom view name");
  expect(source).toEqual(original);
});

it("rejects a mismatched opened session without changing the existing bindings", () => {
  const source = addDeviceView(
    defaults.workspace,
    device,
    session().configuration,
    defaults.settings.terminal,
    "#2266AA",
  ).document;
  const original = structuredClone(source);
  expect(
    addSessionView(
      source,
      { ...session(), deviceId: "a-different-device" },
      { ...device, systemName: "COM9" },
      defaults.settings.terminal,
      "#2266AA",
    ),
  ).toBeUndefined();
  expect(source).toEqual(original);
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
