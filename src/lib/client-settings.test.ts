import { describe, expect, it, vi } from "vitest";
import type {
  ClientStateSnapshot_Serialize as ClientStateSnapshot,
  ClientWindowState_Serialize as ClientWindowState,
} from "./generated/bindings";
import {
  createBrowserClientStateStore,
  createClientSettingsBackend,
  parseClientWindowState,
  parseClientPreferences,
} from "./client-settings";
import { DEFAULT_RECEIVE_HISTORY } from "./receive-history";
import { createClientGallery } from "./client-gallery";
import { createClientDraftStore } from "@/features/workbench/client-drafts";
import { SettingsSync } from "./settings-sync";
const state: ClientWindowState = {
  preferences: {
    menuBar: true,
    windowPosition: "remember",
    sidebarCollapsed: false,
    sidebarWidth: 224,
    receiveHistory: { ...DEFAULT_RECEIVE_HISTORY },
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
    changePreferences() {
      current = {
        ...current,
        revision: String(BigInt(current.revision) + 1n),
        state: {
          ...current.state,
          preferences: { ...current.state.preferences, sidebarWidth: 300 },
        },
      };
    },
  };
}

it("defaults display retention in existing preferences and protects a concurrent retention change", async () => {
  const { receiveHistory: _omitted, ...oldPreferences } = state.preferences;
  expect(parseClientPreferences(oldPreferences).receiveHistory).toEqual(
    DEFAULT_RECEIVE_HISTORY,
  );
  const env = setup();
  const backend = createClientSettingsBackend(env.port);
  const original = await backend.read();
  const fresh = await env.port.read();
  const receiveHistory = { maxRecords: 5000, maxBytes: 4 * 1024 * 1024 };
  await env.port.save(
    {
      ...fresh.state,
      preferences: { ...fresh.state.preferences, receiveHistory },
    },
    fresh.revision,
  );
  await expect(
    backend.save(
      { ...original.value, windowPosition: "center" },
      original.revision,
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await env.port.read()).state.preferences.receiveHistory).toEqual(
    receiveHistory,
  );
});
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
  it("saves startup position after real draft and gallery writes without losing either", async () => {
    sessionStorage.clear();
    const store = createBrowserClientStateStore(
      sessionStorage,
      "client-cas",
      state,
    );
    const port = {
      read: async () => store.read(),
      save: async (value: ClientWindowState, revision: string) =>
        store.save(value, revision),
    };
    const states: string[] = [];
    const sync = new SettingsSync(
      state.preferences,
      createClientSettingsBackend(port),
      (value) => states.push(value.status),
    );
    await sync.start();
    await createClientDraftStore(port).save({ "view-1": "NEW UNSENT" });
    const entry = {
      reference: { hostId: "host", kind: "file", id: "image", revision: "1" },
      name: "Imported image",
    };
    await createClientGallery(port).upsert(entry);
    sync.update({ windowPosition: "center" });
    try {
      await vi.waitFor(() => {
        expect(states.at(-1)).toBe("saved");
        expect(store.read().state.preferences.windowPosition).toBe("center");
      });
      expect(states).not.toContain("error");
      expect(store.read().state).toEqual({
        ...state,
        preferences: { ...state.preferences, windowPosition: "center" },
        drafts: { "view-1": "NEW UNSENT" },
        gallery: [entry],
      });
    } finally {
      sync.stop();
    }
  });
  it("re-reads on explicit preference conflict retry and keeps a concurrent unsent draft", async () => {
    const env = setup();
    const backend = createClientSettingsBackend(env.port);
    let status = "loading";
    const sync = new SettingsSync(state.preferences, backend, (value) => {
      status = value.status;
    });
    await sync.start();
    env.changeDraft();
    env.changePreferences();
    sync.update({ menuBar: false });
    await vi.waitFor(() => expect(status).toBe("error"));
    expect(env.writes).toHaveLength(0);
    await sync.retry();
    expect(env.writes[0]).toMatchObject({
      preferences: { menuBar: false, sidebarWidth: 300 },
      drafts: { "view-1": "NEW UNSENT" },
      follow: false,
    });
    sync.stop();
  });
  it("bounds automatic retries and propagates genuine storage failures immediately", async () => {
    for (const code of ["CONFLICT", "STORAGE_IO"]) {
      const env = setup();
      const save = vi.fn(async () => {
        throw { code };
      });
      const read = vi.fn(env.port.read);
      const backend = createClientSettingsBackend({ read, save });
      const initial = await backend.read();
      await expect(
        backend.save({ ...initial.value, menuBar: false }, initial.revision),
      ).rejects.toEqual({ code });
      expect(save).toHaveBeenCalledTimes(code === "CONFLICT" ? 3 : 1);
      expect(read).toHaveBeenCalledTimes(code === "CONFLICT" ? 3 : 1);
    }
  });
  it("keeps a future document untouched when a conflict refresh encounters it", async () => {
    const env = setup();
    const future = { ...(await env.port.read()), formatVersion: "0.2" };
    const read = vi
      .fn(env.port.read)
      .mockResolvedValueOnce(await env.port.read());
    read.mockResolvedValue(future);
    const save = vi.fn(async () => {
      throw { code: "CONFLICT" };
    });
    const backend = createClientSettingsBackend({ read, save });
    const initial = await backend.read();
    await expect(
      backend.save({ ...initial.value, menuBar: false }, initial.revision),
    ).rejects.toEqual({ code: "FUTURE_FORMAT" });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("browser ClientState isolation", () => {
  it("normalizes the optional gallery input to the complete native output shape", async () => {
    const { createBrowserClientStateStore } = await import("./client-settings");
    sessionStorage.clear();
    const store = createBrowserClientStateStore(
      sessionStorage,
      "optional-gallery",
      state,
    );
    const { gallery: _gallery, ...input } = state;
    const saved = store.save(input, "0");
    expect(saved.state.gallery).toEqual([]);
    expect(store.read()).toEqual(saved);
  });
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
