import { expect, it } from "vitest";
import type { WorkspaceDocument } from "@serial-workbench/contracts";
import { diffWorkspaceImport } from "./workspace-import";

function document(): WorkspaceDocument {
  return {
    name: "Bench",
    views: [],
    bindings: [],
    favoriteBindingIds: ["old"],
    layout: { sidebarWidth: 224, panelHeight: 192 },
    captures: [{ hostId: "host", kind: "capture", id: "capture-a" }],
  };
}
it("compares imported fields against the current draft with values and stable identities", () => {
  const draft = document();
  const candidate = {
    ...document(),
    name: "Imported",
    favoriteBindingIds: ["new"],
    layout: { sidebarWidth: 300, panelHeight: 192 },
    captures: [{ hostId: "host", kind: "capture" as const, id: "capture-b" }],
  };
  expect(diffWorkspaceImport(draft, candidate)).toEqual([
    {
      section: "name",
      key: "name",
      kind: "changed",
      before: "Bench",
      after: "Imported",
    },
    {
      section: "favoriteBindingIds",
      key: "old",
      kind: "removed",
      before: "old",
    },
    { section: "favoriteBindingIds", key: "new", kind: "added", after: "new" },
    {
      section: "favoriteBindingIds",
      key: "$order",
      kind: "changed",
      before: ["old"],
      after: ["new"],
    },
    {
      section: "layout",
      key: "sidebarWidth",
      kind: "changed",
      before: 224,
      after: 300,
    },
    {
      section: "captures",
      key: "host/capture/capture-a",
      kind: "removed",
      before: draft.captures[0],
    },
    {
      section: "captures",
      key: "host/capture/capture-b",
      kind: "added",
      after: candidate.captures[0],
    },
    {
      section: "captures",
      key: "$order",
      kind: "changed",
      before: ["host/capture/capture-a"],
      after: ["host/capture/capture-b"],
    },
  ]);
  expect(draft.name).toBe("Bench");
});
it("shows view and binding additions, removals and changed configuration without treating object key order as an edit", () => {
  const view = {
    id: "v",
    name: "Motor",
    color: "blue",
    icon: "terminal",
    pinned: false,
    receiveMode: "text" as const,
    sendMode: "hex" as const,
    bindingId: "b",
  };
  const draft = { ...document(), views: [view] };
  const candidate = { ...document(), views: [{ ...view, name: "Motor 2" }] };
  expect(diffWorkspaceImport(draft, candidate)).toEqual([
    {
      section: "views",
      key: "v",
      kind: "changed",
      before: view,
      after: candidate.views[0],
    },
  ]);
  expect(
    diffWorkspaceImport(document(), {
      ...document(),
      layout: { panelHeight: 192, sidebarWidth: 224 },
    }),
  ).toEqual([]);
});

it("shows stable binding changes and capture revision changes", async () => {
  const { session } = await import("./test-fixtures");
  const binding = {
    bindingId: "binding-a",
    hostId: "host",
    deviceId: "device",
    fingerprint: {
      transport: "virtual" as const,
      evidence: "unreliable" as const,
    },
    configuration: session().configuration,
    reconnect: { enabled: false, maxDelayMs: "1000", maxAttempts: "3" },
  };
  const draft = {
    ...document(),
    bindings: [binding, { ...binding, bindingId: "removed" }],
  };
  const candidate = {
    ...document(),
    bindings: [
      {
        ...binding,
        configuration: { ...binding.configuration, baudRate: "57600" },
      },
      { ...binding, bindingId: "added" },
    ],
    captures: [
      {
        hostId: "host",
        kind: "capture" as const,
        id: "capture-a",
        revision: "2",
      },
    ],
  };
  expect(diffWorkspaceImport(draft, candidate)).toEqual([
    {
      section: "bindings",
      key: "binding-a",
      kind: "changed",
      before: binding,
      after: candidate.bindings[0],
    },
    {
      section: "bindings",
      key: "removed",
      kind: "removed",
      before: draft.bindings[1],
    },
    {
      section: "bindings",
      key: "added",
      kind: "added",
      after: candidate.bindings[1],
    },
    {
      section: "bindings",
      key: "$order",
      kind: "changed",
      before: ["binding-a", "removed"],
      after: ["binding-a", "added"],
    },
    {
      section: "captures",
      key: "host/capture/capture-a",
      kind: "changed",
      before: draft.captures[0],
      after: candidate.captures[0],
    },
  ]);
});

it("shows ordered view reordering as a change even when each view is unchanged", () => {
  const view = {
    id: "first",
    name: "Motor",
    color: "blue",
    icon: "terminal",
    pinned: false,
    receiveMode: "text" as const,
    sendMode: "hex" as const,
    bindingId: "binding",
  };
  const draft = { ...document(), views: [view, { ...view, id: "second" }] };
  const candidate = {
    ...document(),
    views: [draft.views[1]!, draft.views[0]!],
  };
  expect(diffWorkspaceImport(draft, candidate)).toEqual([
    {
      section: "views",
      key: "$order",
      kind: "changed",
      before: ["first", "second"],
      after: ["second", "first"],
    },
  ]);
});

it.each(["views", "bindings", "favoriteBindingIds", "captures"] as const)(
  "previews the final %s order when adding a member and reordering existing members",
  async (section) => {
    const { session } = await import("./test-fixtures");
    function ordered(ids: string[]): WorkspaceDocument {
      const value = document();
      if (section === "views")
        value.views = ids.map((id) => ({
          id,
          name: id,
          color: "blue",
          icon: "terminal",
          pinned: false,
          receiveMode: "text",
          sendMode: "hex",
          bindingId: id,
        }));
      if (section === "bindings")
        value.bindings = ids.map((bindingId) => ({
          bindingId,
          hostId: "host",
          deviceId: "device",
          fingerprint: { transport: "virtual", evidence: "unreliable" },
          configuration: session().configuration,
          reconnect: { enabled: false, maxDelayMs: "1000", maxAttempts: "3" },
        }));
      if (section === "favoriteBindingIds") value.favoriteBindingIds = ids;
      if (section === "captures")
        value.captures = ids.map((id) => ({
          hostId: "host",
          kind: "capture",
          id,
        }));
      return value;
    }
    const changes = diffWorkspaceImport(
      ordered(["a", "b"]),
      ordered(["b", "a", "c"]),
    );
    expect
      .soft(
        changes.find(
          (change) => change.section === section && change.key === "$order",
        ),
      )
      .toEqual({
        section,
        key: "$order",
        kind: "changed",
        before:
          section === "captures"
            ? ["host/capture/a", "host/capture/b"]
            : ["a", "b"],
        after:
          section === "captures"
            ? ["host/capture/b", "host/capture/a", "host/capture/c"]
            : ["b", "a", "c"],
      });
    expect(
      changes.find(
        (change) => change.section === section && change.kind === "added",
      )?.key,
    ).toBe(section === "captures" ? "host/capture/c" : "c");
    const removed = diffWorkspaceImport(
      ordered(["a", "b", "c"]),
      ordered(["c", "a"]),
    );
    expect(
      removed.find(
        (change) => change.section === section && change.key === "$order",
      ),
    ).toEqual({
      section,
      key: "$order",
      kind: "changed",
      before:
        section === "captures"
          ? ["host/capture/a", "host/capture/b", "host/capture/c"]
          : ["a", "b", "c"],
      after:
        section === "captures"
          ? ["host/capture/c", "host/capture/a"]
          : ["c", "a"],
    });
    expect(
      removed.find(
        (change) => change.section === section && change.kind === "removed",
      )?.key,
    ).toBe(section === "captures" ? "host/capture/b" : "b");
  },
);
