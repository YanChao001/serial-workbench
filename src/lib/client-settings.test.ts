import { describe, expect, it, vi } from "vitest";
import type {
  ClientStateSnapshot,
  ClientWindowState,
} from "./generated/bindings";
import {
  createClientSettingsBackend,
  parseClientWindowState,
} from "./client-settings";
import { SettingsSync } from "./settings-sync";
const state: ClientWindowState = {
  preferences: {
    menuBar: true,
    windowPosition: "remember",
    sidebarCollapsed: false,
    sidebarWidth: 224,
  },
  currentPage: "workbench",
  focusedPanelId: "terminal",
  scrollOffset: 12,
  follow: false,
  lastWorkspaceId: "bench",
  drafts: { "view-1": "AT+UNSENT" },
  gallery: [],
};
function setup() {
  let current: ClientStateSnapshot = {
    formatVersion: "0.1",
    revision: "3",
    state: structuredClone(state),
  };
  const writes: ClientWindowState[] = [];
  const port = {
    read: async () => current,
    save: async (value: ClientWindowState, revision: string) => {
      if (revision !== current.revision) throw { code: "CONFLICT" };
      writes.push(value);
      current = {
        formatVersion: "0.1",
        revision: String(BigInt(revision) + 1n),
        state: value,
      };
      return current;
    },
  };
  return {
    port,
    writes,
    changeDraft() {
      current = {
        ...current,
        revision: "4",
        state: { ...current.state, drafts: { "view-1": "NEW UNSENT" } },
      };
    },
  };
}
describe("client preference persistence", () => {
  it("accepts a client gallery of pinned Host file references without embedding media", () => {
    const gallery = [
      {
        reference: { hostId: "host", kind: "file", id: "image", revision: "1" },
        name: "  Sky 🌤  ",
      },
    ];
    expect(parseClientWindowState({ ...state, gallery })).toMatchObject({
      gallery,
      drafts: state.drafts,
    });
  });
  it.each(
    [
      [
        {
          reference: { hostId: "host", kind: "file", id: "image" },
          name: "sky",
        },
      ],
      [
        {
          reference: {
            hostId: "host",
            kind: "session",
            id: "session",
            revision: "1",
          },
          name: "sky",
        },
      ],
      [
        {
          reference: {
            hostId: "host",
            kind: "file",
            id: "image",
            revision: "1",
          },
          name: " ",
        },
      ],
      [
        {
          reference: {
            hostId: "host",
            kind: "file",
            id: "image",
            revision: "1",
          },
          name: "sky\n",
        },
      ],
      [
        {
          reference: {
            hostId: "host",
            kind: "file",
            id: "image",
            revision: "1",
          },
          name: "🌤".repeat(121),
        },
      ],
      [1, 2].map((revision) => ({
        reference: {
          hostId: "host",
          kind: "file",
          id: "image",
          revision: String(revision),
        },
        name: "sky",
      })),
    ].map((gallery) => ({ gallery })),
  )(
    "rejects malformed, unpinned or duplicate gallery entries",
    ({ gallery }) => {
      expect(() => parseClientWindowState({ ...state, gallery })).toThrow();
    },
  );
  it("saves only client preferences without losing navigation, follow or pending drafts", async () => {
    const env = setup();
    const backend = createClientSettingsBackend(env.port);
    const read = await backend.read();
    await backend.save({ ...read.value, sidebarWidth: 300 }, read.revision);
    expect(env.writes[0]).toEqual({
      ...state,
      preferences: { ...state.preferences, sidebarWidth: 300 },
    });
    expect(env.writes[0]).not.toHaveProperty("theme");
  });
  it("re-reads on explicit conflict retry and keeps a concurrent unsent draft", async () => {
    const env = setup();
    const backend = createClientSettingsBackend(env.port);
    let status = "loading";
    const sync = new SettingsSync(state.preferences, backend, (value) => {
      status = value.status;
    });
    await sync.start();
    env.changeDraft();
    sync.update({ menuBar: false });
    await vi.waitFor(() => expect(status).toBe("error"));
    expect(env.writes).toHaveLength(0);
    await sync.retry();
    expect(env.writes[0]).toMatchObject({
      preferences: { menuBar: false },
      drafts: { "view-1": "NEW UNSENT" },
      follow: false,
    });
    sync.stop();
  });
});

describe("browser ClientState isolation", () => {
  it("uses generated client defaults through the same browser port used by preferences and drafts", async () => {
    sessionStorage.clear();
    const client = await import("./client-settings");
    const generated = await import("./generated/client-defaults.json");
    const snapshot = await client.readClientWindowState();
    expect(snapshot.state).toEqual(generated.default);
    await client.saveClientWindowState(
      { ...snapshot.state, drafts: { view: "unsent" } },
      snapshot.revision,
    );
    expect((await client.readClientWindowState()).state.drafts).toEqual({
      view: "unsent",
    });
    expect(
      sessionStorage.getItem(client.BROWSER_CLIENT_STATE_KEY),
    ).toBeTruthy();
  });
  it.each([
    { currentPage: "https://example.com" },
    { focusedPanelId: "unknown" },
    { drafts: { "bad/key": "hi\u0000" } },
  ])(
    "rejects client state the native store cannot accept: %j",
    async (patch) => {
      sessionStorage.clear();
      const { createBrowserClientStateStore } =
        await import("./client-settings");
      const store = createBrowserClientStateStore(
        sessionStorage,
        "test-client-v0",
        state,
      );
      expect(() => store.save({ ...state, ...patch }, "0")).toThrow();
      expect(sessionStorage.getItem("test-client-v0")).toBeNull();
    },
  );
  it("shares one CAS document for preferences and drafts, isolated from localStorage", async () => {
    sessionStorage.clear();
    localStorage.clear();
    const { createBrowserClientStateStore } = await import("./client-settings");
    const store = createBrowserClientStateStore(
      sessionStorage,
      "test-client-v0",
      state,
    );
    const first = store.read();
    const savedDraft = store.save(
      { ...first.state, drafts: { "view-2": "pending" } },
      first.revision,
    );
    expect(() =>
      store.save(
        {
          ...first.state,
          preferences: { ...first.state.preferences, menuBar: false },
        },
        first.revision,
      ),
    ).toThrow();
    const next = store.save(
      {
        ...savedDraft.state,
        preferences: { ...savedDraft.state.preferences, menuBar: false },
      },
      savedDraft.revision,
    );
    expect(next.state).toMatchObject({
      drafts: { "view-2": "pending" },
      preferences: { menuBar: false },
    });
    expect(localStorage.length).toBe(0);
  });
  it.each([
    '{"formatVersion":"0.2","revision":"0","state":{}}',
    '{"formatVersion":"0.1",',
    JSON.stringify({
      formatVersion: "0.1",
      revision: "0",
      state,
      injected: true,
    }),
    JSON.stringify({
      formatVersion: "0.1",
      revision: "0",
      state: {
        ...state,
        preferences: { ...state.preferences, sidebarWidth: "300" },
      },
    }),
  ])("keeps unreadable client bytes untouched: %s", async (raw) => {
    const { createBrowserClientStateStore } = await import("./client-settings");
    sessionStorage.setItem("test-client-v0", raw);
    const store = createBrowserClientStateStore(
      sessionStorage,
      "test-client-v0",
      state,
    );
    expect(() => store.read()).toThrow();
    expect(() => store.save(state, "0")).toThrow();
    expect(sessionStorage.getItem("test-client-v0")).toBe(raw);
  });
});
