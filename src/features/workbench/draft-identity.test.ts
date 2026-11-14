import { expect, it } from "vitest";
import { defaults, type WorkspaceDocument } from "@serial-workbench/contracts";
import { restoreViewDraftIdentity, viewDraftKey } from "./draft-identity";

function workspace(...viewIds: string[]): WorkspaceDocument {
  return {
    ...defaults.workspace,
    views: viewIds.map((id) => ({
      id,
      name: id,
      color: "#2266AA",
      icon: "terminal",
      pinned: false,
      receiveMode: "text",
      sendMode: "text",
      receiveEncoding: "utf-8",
      sendEncoding: "utf-8",
      bindingId: "binding",
    })),
  };
}

it("isolates matching view identifiers across stable workspace scopes", () => {
  expect(viewDraftKey("workspace-a", "same-view")).toBe(
    'view/["workspace-a","same-view"]',
  );
  expect(viewDraftKey("workspace-b", "same-view")).toBe(
    'view/["workspace-b","same-view"]',
  );
  expect(viewDraftKey("workspace-a", "same-view")).not.toBe(
    viewDraftKey("workspace-b", "same-view"),
  );
});

it("keeps temporary view keys separate from the window's unconnected draft", () => {
  expect(viewDraftKey(undefined, "session-view")).toBe("session-view");
  expect(viewDraftKey(undefined, "unconnected")).toBe("view/unconnected");
});

it("claims only the current workspace's legacy view drafts without changing unrelated or window drafts", () => {
  const drafts = Object.freeze({
    first: "first original\r\n",
    empty: "",
    other: "not this workspace",
    unconnected: "window draft",
    'view/["another-workspace","first"]': "another workspace",
  });
  const restored = restoreViewDraftIdentity(
    drafts,
    workspace("first", "empty"),
    drafts.unconnected,
    "workspace-a",
  );
  expect(restored).toEqual({
    'view/["workspace-a","first"]': "first original\r\n",
    'view/["workspace-a","empty"]': "",
    other: "not this workspace",
    unconnected: "window draft",
    'view/["another-workspace","first"]': "another workspace",
  });
  expect(drafts.first).toBe("first original\r\n");
  expect(Object.hasOwn(drafts, "empty")).toBe(true);
});

it("preserves an existing empty scoped draft and leaves an unclaimed legacy draft for its owner", () => {
  const drafts = Object.freeze({
    shared: "unclaimed original",
    'view/["workspace-a","shared"]': "",
  });
  const restoredA = restoreViewDraftIdentity(
    drafts,
    workspace("shared"),
    undefined,
    "workspace-a",
  );
  expect(restoredA).toBe(drafts);
  const restoredB = restoreViewDraftIdentity(
    restoredA,
    workspace("shared"),
    undefined,
    "workspace-b",
  );
  expect(restoredB).toEqual({
    'view/["workspace-a","shared"]': "",
    'view/["workspace-b","shared"]': "unclaimed original",
  });
});

it("does not let a later workspace reuse a legacy draft already claimed by the first workspace", () => {
  const restoredA = restoreViewDraftIdentity(
    { shared: "belongs to the first workspace" },
    workspace("shared"),
    undefined,
    "workspace-a",
  );
  const restoredB = restoreViewDraftIdentity(
    restoredA,
    workspace("shared"),
    undefined,
    "workspace-b",
  );
  expect(restoredB).toBe(restoredA);
  expect(restoredB).toEqual({
    'view/["workspace-a","shared"]': "belongs to the first workspace",
  });
  expect(Object.hasOwn(restoredB, viewDraftKey("workspace-b", "shared"))).toBe(
    false,
  );
});

it("moves the legacy unconnected view without consuming the independent window draft", () => {
  const drafts = Object.freeze({
    unconnected: "window original",
    "view/unconnected": "view original",
  });
  const restored = restoreViewDraftIdentity(
    drafts,
    workspace("unconnected"),
    drafts.unconnected,
    "workspace-a",
  );
  expect(restored).toEqual({
    unconnected: "window original",
    'view/["workspace-a","unconnected"]': "view original",
  });
  expect(drafts["view/unconnected"]).toBe("view original");
});

it("does not initialize another workspace's unconnected view from a window original already assigned to a workspace", () => {
  const restoredA = restoreViewDraftIdentity(
    { unconnected: "initial window original" },
    workspace("unconnected"),
    "initial window original",
    "workspace-a",
  );
  expect(restoredA).toEqual({
    unconnected: "initial window original",
    'view/["workspace-a","unconnected"]': "initial window original",
  });
  const restoredB = restoreViewDraftIdentity(
    restoredA,
    workspace("unconnected"),
    "initial window original",
    "workspace-b",
  );
  expect(restoredB).toBe(restoredA);
  expect(
    Object.hasOwn(restoredB, viewDraftKey("workspace-b", "unconnected")),
  ).toBe(false);
  const editedB = {
    ...restoredB,
    [viewDraftKey("workspace-b", "unconnected")]: "explicit workspace B edit",
  };
  expect(
    restoreViewDraftIdentity(
      editedB,
      workspace("unconnected"),
      "initial window original",
      "workspace-a",
    ),
  ).toEqual({
    unconnected: "initial window original",
    'view/["workspace-a","unconnected"]': "initial window original",
    'view/["workspace-b","unconnected"]': "explicit workspace B edit",
  });
});

it.each([
  ["ordinary", "unconnected"],
  ["unconnected", "ordinary"],
])(
  "initializes the first document independently of view order %s, %s",
  (...views) => {
    expect(
      restoreViewDraftIdentity(
        { ordinary: "legacy view text", unconnected: "window original" },
        workspace(...views),
        "window original",
        "workspace-a",
      ),
    ).toEqual({
      unconnected: "window original",
      'view/["workspace-a","ordinary"]': "legacy view text",
      'view/["workspace-a","unconnected"]': "window original",
    });
  },
);

it("still claims a separate legacy unconnected view when another workspace already owns a draft", () => {
  expect(
    restoreViewDraftIdentity(
      {
        unconnected: "window original",
        "view/unconnected": "separate legacy view",
        'view/["workspace-a","ordinary"]': "owned workspace A text",
      },
      workspace("unconnected"),
      "window original",
      "workspace-b",
    ),
  ).toEqual({
    unconnected: "window original",
    'view/["workspace-a","ordinary"]': "owned workspace A text",
    'view/["workspace-b","unconnected"]': "separate legacy view",
  });
});

it.each(["initial window draft\r\n", ""])(
  "initializes an unconnected view from the window original %j only when its own draft is absent",
  (original) => {
    const drafts = { unconnected: original };
    const restored = restoreViewDraftIdentity(
      drafts,
      workspace("unconnected"),
      original,
      "workspace-a",
    );
    expect(restored).toEqual({
      unconnected: original,
      'view/["workspace-a","unconnected"]': original,
    });
    expect(
      restoreViewDraftIdentity(
        restored,
        workspace("unconnected"),
        "a later window draft must not replace it",
        "workspace-a",
      ),
    ).toBe(restored);
  },
);

it("treats an empty legacy unconnected view as owned content ahead of a window original", () => {
  const restored = restoreViewDraftIdentity(
    { unconnected: "window", "view/unconnected": "" },
    workspace("unconnected"),
    "window",
    "workspace-a",
  );
  expect(restored).toEqual({
    unconnected: "window",
    'view/["workspace-a","unconnected"]': "",
  });
});

it("keeps unscoped view recovery compatible and distinct from the window original", () => {
  const drafts = { first: "temporary", unconnected: "window" };
  const restored = restoreViewDraftIdentity(
    drafts,
    workspace("first", "unconnected"),
    drafts.unconnected,
    undefined,
  );
  expect(restored).toEqual({
    first: "temporary",
    unconnected: "window",
    "view/unconnected": "window",
  });
  expect(
    restoreViewDraftIdentity(
      restored,
      workspace("first", "unconnected"),
      drafts.unconnected,
      undefined,
    ),
  ).toBe(restored);
});

it("leaves unread workspaces, unrelated views, capture keys and other scopes untouched", () => {
  const drafts = Object.freeze({
    absent: "not selected",
    unconnected: "window",
    "capture/reference": "leave this alone",
    'view/["another-workspace","same-view"]': "another scope",
  });
  expect(
    restoreViewDraftIdentity(drafts, undefined, "window", "workspace-a"),
  ).toBe(drafts);
  expect(
    restoreViewDraftIdentity(drafts, workspace(), "window", "workspace-a"),
  ).toBe(drafts);
  expect(
    restoreViewDraftIdentity(
      drafts,
      workspace("same-view"),
      "window",
      "workspace-a",
    ),
  ).toBe(drafts);
});

it("claims runtime view identities from a minimal descriptor and remains idempotent", () => {
  const views = { views: [{ id: "runtime-view" }] };
  const restored = restoreViewDraftIdentity(
    { "runtime-view": "unsent runtime text" },
    views,
    undefined,
    "workspace-a",
  );
  expect(restored).toEqual({
    'view/["workspace-a","runtime-view"]': "unsent runtime text",
  });
  expect(
    restoreViewDraftIdentity(restored, views, undefined, "workspace-a"),
  ).toBe(restored);
});

it("ignores inherited properties and safely claims explicitly stored prototype-shaped identifiers", () => {
  const views = workspace("constructor", "__proto__");
  const empty = {};
  expect(restoreViewDraftIdentity(empty, views, undefined, "workspace-a")).toBe(
    empty,
  );
  const drafts = Object.freeze({
    constructor: "constructor original",
    ["__proto__"]: "prototype original",
  });
  expect(
    restoreViewDraftIdentity(drafts, views, undefined, "workspace-a"),
  ).toEqual({
    'view/["workspace-a","constructor"]': "constructor original",
    'view/["workspace-a","__proto__"]': "prototype original",
  });
  expect(Object.getPrototypeOf(drafts)).toBe(Object.prototype);
});
