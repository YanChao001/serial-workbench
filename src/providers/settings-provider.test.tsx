import { StrictMode, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaults,
  type Operation,
  type SettingsSnapshot,
  type JsonValue,
  type OperationSummary,
} from "@serial-workbench/contracts";
import { toast } from "sonner";
import {
  SettingsPersistence,
  SettingsPersistenceRetry,
} from "@/components/settings-persistence";
import { OperationFailureObserver } from "@/features/workbench/operation-failure-notices";
import { operation } from "@/features/workbench/test-fixtures";
import { clearUserLog, getUserLog } from "@/lib/user-log";
import {
  DEFAULT_SETTINGS,
  settingsDocument,
  STORAGE_KEY,
} from "@/lib/settings-model";
import type { SettingsBackend } from "@/lib/settings-sync";
import { SettingsSync } from "@/lib/settings-sync";
import { createHostSettingsBackend } from "@/lib/host-settings";
import type { HostConnection } from "@/lib/host-client";
import { SettingsProvider, useSettings } from "./settings";
import { BROWSER_CLIENT_STATE_KEY } from "@/lib/client-settings";

const env = vi.hoisted(() => ({
  native: false,
  backend: undefined as SettingsBackend | undefined,
  connection: undefined as object | undefined,
  clientWrites: [] as unknown[],
  effects: [] as string[],
  effectsWait: undefined as Promise<void> | undefined,
  hostError: null as { code: string } | null,
  choose: vi.fn(),
  resolveMedia: vi.fn(),
  releaseMedia: vi.fn(),
  realBackend: false,
  documentIntent: vi.fn(),
  reportError: vi.fn(),
  summaries: [] as OperationSummary[],
}));
vi.mock("sonner", () => ({
  toast: { custom: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/providers/i18n", () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock("@/lib/report-error", () => ({ reportClientError: env.reportError }));
vi.mock("@/lib/tauri", () => ({
  isTauri: () => env.native,
  hostApplyDocumentIntent: (...args: unknown[]) => env.documentIntent(...args),
  chooseFileResource: (...args: unknown[]) => env.choose(...args),
  mediaResolve: (...args: unknown[]) => env.resolveMedia(...args),
  mediaRelease: (...args: unknown[]) => env.releaseMedia(...args),
  readClientState: async () => ({
    formatVersion: "0.1",
    revision: env.realBackend ? String(2 + env.clientWrites.length) : "2",
    state: {
      preferences: {
        menuBar: true,
        windowPosition: "remember",
        sidebarCollapsed: false,
        sidebarWidth: 224,
      },
      currentPage: "workbench",
      focusedPanelId: null,
      scrollOffset: 0,
      follow: true,
      lastWorkspaceId: null,
      drafts: { "view-1": "unsent" },
    },
  }),
  saveClientState: async (state: unknown, revision: string) => {
    env.clientWrites.push({ state, revision });
    return {
      formatVersion: "0.1",
      revision: String(BigInt(revision) + 1n),
      state,
    };
  },
  applyHostSettingsEffects: async () => {
    env.effects.push("applied");
    if (env.effectsWait) await env.effectsWait;
    return {
      hostId: "host",
      instanceEpoch: "1",
      revision: env.realBackend ? "18446744073709551615" : "4",
      effects: { trayLanguage: true, networkMode: true, runInBackground: true },
    };
  },
}));
vi.mock("./host-context", async () => {
  const { createContext, useContext } = await import("react");
  const HostContext = createContext({
    get connection() {
      return env.connection;
    },
    get state() {
      return {
        status: env.hostError ? "error" : "ready",
        error: env.hostError,
        operationSummaries: env.summaries,
      };
    },
  });
  return { HostContext, useHost: () => useContext(HostContext) };
});
vi.mock("@/lib/host-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host-settings")>();
  return {
    createHostSettingsBackend: (
      connection: Parameters<typeof actual.createHostSettingsBackend>[0],
    ) =>
      env.realBackend
        ? actual.createHostSettingsBackend(connection)
        : { ...env.backend, markExplicitEdit() {}, dispose() {} },
  };
});
const wrapper = ({ children }: { children: ReactNode }) => (
  <SettingsProvider>{children}</SettingsProvider>
);
const strict = ({ children }: { children: ReactNode }) => (
  <StrictMode>
    <SettingsProvider>{children}</SettingsProvider>
  </StrictMode>
);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  env.native = false;
  env.connection = undefined;
  env.clientWrites = [];
  env.effects = [];
  env.effectsWait = undefined;
  env.hostError = null;
  env.summaries = [];
  env.realBackend = false;
  env.documentIntent.mockReset();
  env.choose.mockReset();
  env.resolveMedia.mockReset();
  env.releaseMedia.mockReset();
});

function localHost(generation = "12") {
  const target = { hostId: "host", kind: "settings", id: "shared" };
  const scope = { scopeId: "settings-scope", target };
  let current: SettingsSnapshot = { revision: "3", value: defaults.settings };
  let allowed = false;
  let conflict = false;
  let saving: Promise<void> | undefined;
  const writes: Array<{ source: string; revision: string; value: JsonValue }> =
    [];
  const listeners = new Set<(event: unknown) => void>();
  const save = async (source: string, revision: string, value: JsonValue) => {
    writes.push({ source, revision, value });
    if (saving) await saving;
    if (!allowed) throw { code: "PERMISSION_DENIED" };
    if (conflict) {
      conflict = false;
      current = { revision: "4", value: { ...current.value, accent: "cyan" } };
      throw { code: "REVISION_CONFLICT" };
    }
    if (revision !== current.revision) throw { code: "REVISION_CONFLICT" };
    current = {
      revision: String(BigInt(revision) + 1n),
      value: value as unknown as SettingsSnapshot["value"],
    };
    return {
      operationId: "save-op",
      executionHostId: "host",
      actorId: "actor",
      requestId: "00000000-0000-4000-8000-000000000001",
      admission: { kind: "request", requestContextDigest: "a".repeat(64) },
      rootOperationId: "save-op",
      childHighWatermark: "0",
      actionId: "settings.save",
      target,
      executionMode: "interactive",
      state: "succeeded",
      revision: "2",
      revealTarget: { pageId: "settings" },
      acceptedAt: "2026-11-08T00:00:00Z",
      owner: { kind: "host", id: "host" },
      result: { kind: "settings", value: { document: current, scope } },
    } satisfies Operation;
  };
  const connection = {
    generation,
    attachment: { hostId: "host", instanceEpoch: "1" },
    client: {
      query: async () => ({
        kind: "settings",
        value: { document: current, scope },
      }),
      invoke: async (call: {
        expectedRevision: string;
        params: { value: JsonValue };
      }) => save("business", call.expectedRevision, call.params.value),
      subscribe: async (_scope: string, listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    refreshScopes: async () => [],
    buildQuery: () => ({}),
    buildCall: (
      _action: string,
      _target: unknown,
      params: unknown,
      options: object,
    ) => ({ ...options, params }),
  };
  env.native = true;
  env.realBackend = true;
  env.connection = connection;
  env.documentIntent.mockImplementation(
    async (
      actualGeneration: string,
      intent: {
        kind: string;
        expectedRevision: string;
        params: { value: JsonValue };
      },
    ) => {
      expect(actualGeneration).toBe(generation);
      expect(intent.kind).toBe("settingsSave");
      allowed = true;
      return save("intent", intent.expectedRevision, intent.params.value);
    },
  );
  return {
    connection,
    writes,
    listeners,
    revoke() {
      allowed = false;
    },
    conflict() {
      conflict = true;
    },
    hold(promise: Promise<void> | undefined) {
      saving = promise;
    },
    remote() {
      for (const listener of listeners)
        listener({
          type: "snapshot",
          snapshot: { state: { document: current, scope } },
        });
    },
  };
}

describe("local shared settings intent through the real synchronization adapter", () => {
  it.each(["observer-first", "persistence-first"])(
    "notifies one verified settings failure through the real provider and permanent observer (%s)",
    async (order) => {
      localHost();
      const failed: Operation = {
        ...operation(`settings-terminal-${order}`),
        actionId: "settings.save",
        target: { hostId: "host", kind: "settings", id: "shared" },
        state: "failed",
        error: {
          code: "STORAGE_IO",
          message: "private user path and storage contents",
          retryable: false,
        },
      };
      let finish!: (value: Operation) => void;
      env.documentIntent.mockImplementationOnce(
        () =>
          new Promise<Operation>((resolve) => {
            finish = resolve;
          }),
      );
      const view = renderHook(() => useSettings(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <SettingsProvider>
            <OperationFailureObserver />
            <SettingsPersistence compact />
            <header>
              <SettingsPersistenceRetry />
            </header>
            {children}
          </SettingsProvider>
        ),
      });
      await waitFor(() =>
        expect(view.result.current.persistence).toBe("saved"),
      );
      act(() => view.result.current.update({ accent: "cyan" }));
      await waitFor(() => expect(env.documentIntent).toHaveBeenCalledOnce());
      const observeFailure = (value = failed) => {
        env.summaries = [{ ...value, errorCode: value.error!.code }];
        view.rerender();
      };
      if (order === "observer-first") observeFailure();
      await act(async () => finish(failed));
      await waitFor(() =>
        expect(view.result.current.persistence).toBe("error"),
      );
      if (order === "persistence-first") observeFailure();
      expect(
        vi.mocked(toast.error).mock.calls.length +
          vi.mocked(toast.custom).mock.calls.length,
      ).toBe(1);
      expect(
        getUserLog().reduce((count, entry) => count + entry.count, 0),
      ).toBe(1);
      expect(getUserLog()[0]).toMatchObject({
        module: "settings",
        code: "STORAGE_IO",
      });
      expect(JSON.stringify(getUserLog())).not.toContain("private user path");
      const previousEvent = view.result.current.persistenceEventKey;
      expect(previousEvent).toEqual(expect.any(String));
      const second = { ...failed, operationId: `${failed.operationId}-retry` };
      env.documentIntent.mockImplementationOnce(
        () =>
          new Promise<Operation>((resolve) => {
            finish = resolve;
          }),
      );
      fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
      await waitFor(() => expect(env.documentIntent).toHaveBeenCalledTimes(2));
      expect(view.result.current.persistenceEventKey).toBeUndefined();
      if (order === "observer-first") observeFailure(second);
      await act(async () => finish(second));
      await waitFor(() =>
        expect(view.result.current.persistence).toBe("error"),
      );
      if (order === "persistence-first") observeFailure(second);
      expect(view.result.current.persistenceEventKey).not.toBe(previousEvent);
      expect(
        vi.mocked(toast.error).mock.calls.length +
          vi.mocked(toast.custom).mock.calls.length,
      ).toBe(2);
      expect(
        getUserLog().reduce((count, entry) => count + entry.count, 0),
      ).toBe(2);
      expect(
        screen.getByRole("button", { name: "common.retry" }),
      ).toBeEnabled();
      view.unmount();
    },
  );
  it("keeps persistence pending until the original native effects receipt completes", async () => {
    let release!: () => void;
    env.effectsWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    localHost();
    const { result } = renderHook(() => useSettings(), { wrapper });
    try {
      await waitFor(() => expect(env.effects.length).toBeGreaterThan(0));
      await waitFor(() =>
        expect(result.current.persistence).not.toBe("loading"),
      );
      expect(result.current.persistence).toBe("saving");
    } finally {
      await act(async () => release());
    }
    await waitFor(() => expect(result.current.persistence).toBe("saved"));
  });

  it("does not let an old attachment receipt finish the current settings effects", async () => {
    let releaseOld!: () => void;
    let releaseCurrent: (() => void) | undefined;
    env.effectsWait = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    localHost("12");
    const { result, rerender } = renderHook(() => useSettings(), { wrapper });
    try {
      await waitFor(() => expect(env.effects).toHaveLength(1));
      env.effectsWait = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      localHost("13");
      rerender();
      await waitFor(() => expect(env.effects).toHaveLength(2));
      await act(async () => releaseOld());
      expect(result.current.persistence).toBe("saving");
      await act(async () => releaseCurrent?.());
      await waitFor(() => expect(result.current.persistence).toBe("saved"));
    } finally {
      await act(async () => {
        releaseOld();
        releaseCurrent?.();
      });
    }
  });

  it("keeps a failed effects receipt explicit until the user retries", async () => {
    let rejectEffects!: (reason: unknown) => void;
    env.effectsWait = new Promise<void>((_resolve, reject) => {
      rejectEffects = reject;
    });
    const host = localHost();
    const { result } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(env.effects).toHaveLength(1));
    await act(async () => rejectEffects({ code: "PERMISSION_DENIED" }));
    await waitFor(() => expect(result.current.persistence).toBe("error"));
    expect(result.current.persistenceError).toBe("PERMISSION_DENIED");
    expect(env.effects).toHaveLength(1);
    env.effectsWait = undefined;
    act(() => result.current.retrySave());
    await waitFor(() => expect(result.current.persistence).toBe("saved"));
    expect(env.effects).toHaveLength(2);
    expect(host.writes).toHaveLength(0);
  });

  it("keeps CAS merge and background retries on the business client after consuming one intent", async () => {
    const host = localHost();
    const backend = createHostSettingsBackend(
      host.connection as unknown as HostConnection,
    );
    let state:
      | {
          status: string;
          error: string | null;
          settings: typeof defaults.settings;
        }
      | undefined;
    const sync = new SettingsSync(defaults.settings, backend, (value) => {
      state = value;
    });
    await sync.start();
    await expect(backend.save(defaults.settings, "3")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(env.documentIntent).not.toHaveBeenCalled();
    host.conflict();
    backend.markExplicitEdit();
    sync.update({ font: "mono" });
    await waitFor(() => expect(state?.error).toBe("REVISION_CONFLICT"));
    host.remote();
    expect(state?.settings).toMatchObject({ font: "mono", accent: "cyan" });
    expect(host.writes).toHaveLength(2);
    await sync.retry();
    expect(state).toMatchObject({
      status: "saved",
      settings: { font: "mono", accent: "cyan" },
    });
    expect(host.writes.map((write) => write.source)).toEqual([
      "business",
      "intent",
      "business",
    ]);
    expect(host.writes.at(-1)?.revision).toBe("4");
    host.revoke();
    sync.update({ language: "en" });
    await waitFor(() => expect(state?.error).toBe("PERMISSION_DENIED"));
    await sync.retry();
    expect(state?.error).toBe("PERMISSION_DENIED");
    expect(env.documentIntent).toHaveBeenCalledTimes(1);
    backend.markExplicitEdit();
    await sync.retry();
    expect(state).toMatchObject({
      status: "saved",
      settings: { language: "en", font: "mono", accent: "cyan" },
    });
    expect(env.documentIntent).toHaveBeenCalledTimes(2);
    sync.stop();
    backend.dispose();
  });

  it("does not consume a new explicit edit when an older save finishes", async () => {
    const host = localHost();
    const { result } = renderHook(useSettings, { wrapper });
    await waitFor(() => expect(result.current.persistence).toBe("saved"));
    let release!: () => void;
    host.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    act(() => result.current.update({ font: "mono" }));
    await waitFor(() => expect(host.writes).toHaveLength(1));
    act(() => result.current.update({ language: "en" }));
    host.hold(undefined);
    await act(async () => release());
    await waitFor(() => expect(result.current.persistence).toBe("saved"));
    expect(host.writes).toMatchObject([
      {
        source: "intent",
        revision: "3",
        value: { font: "mono", language: "zh" },
      },
      {
        source: "intent",
        revision: "4",
        value: { font: "mono", language: "en" },
      },
    ]);
  });

  it("does not carry pending intent or late completion into a new attachment generation", async () => {
    const first = localHost("12");
    const { result, rerender } = renderHook(useSettings, { wrapper: strict });
    await waitFor(() => expect(result.current.persistence).toBe("saved"));
    let release!: () => void;
    first.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    act(() => result.current.update({ font: "mono" }));
    await waitFor(() => expect(first.writes).toHaveLength(1));
    act(() => result.current.update({ language: "en" }));
    const second = localHost("13");
    rerender();
    await waitFor(() =>
      expect(result.current.persistenceError).toBe("PERMISSION_DENIED"),
    );
    expect(second.writes).toMatchObject([
      {
        source: "business",
        revision: "3",
        value: { font: "mono", language: "en" },
      },
    ]);
    expect(env.documentIntent).toHaveBeenCalledTimes(1);
    await act(async () => release());
    expect(result.current.persistenceError).toBe("PERMISSION_DENIED");
    act(() => result.current.retrySave());
    await waitFor(() => expect(result.current.persistence).toBe("saved"));
    expect(second.writes[1]).toMatchObject({ source: "intent", revision: "3" });
    expect(env.documentIntent).toHaveBeenCalledTimes(2);
    expect(first.listeners.size).toBe(0);
  });

  it("grants only for explicit shared edits, reset and retry, retaining client isolation", async () => {
    const host = localHost();
    const { result } = renderHook(useSettings, { wrapper: strict });
    await waitFor(() => expect(result.current.persistence).toBe("saved"));
    expect(host.writes).toEqual([]);
    act(() => result.current.update({ menuBar: false }));
    await waitFor(() => expect(env.clientWrites).toHaveLength(1));
    expect(host.writes).toEqual([]);
    act(() => result.current.update({ font: "mono" }));
    await waitFor(() => expect(result.current.persistence).toBe("saved"));
    expect(host.writes).toMatchObject([
      { source: "intent", revision: "3", value: { font: "mono" } },
    ]);
    host.revoke();
    act(() => result.current.retrySave());
    await waitFor(() => expect(result.current.persistence).toBe("saved"));
    expect(host.writes).toHaveLength(1);
    act(() => result.current.update({ language: "en" }));
    await waitFor(() => expect(host.writes).toHaveLength(2));
    expect(host.writes[1]).toMatchObject({ source: "intent", revision: "4" });
    await waitFor(() => expect(result.current.persistence).toBe("saved"));
    await act(() => result.current.reset());
    expect(host.writes[2]).toMatchObject({
      source: "intent",
      revision: "5",
      value: { font: "geist", language: "en" },
    });
  });
});
afterEach(() => {
  cleanup();
  clearUserLog();
  vi.mocked(toast.custom).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.dismiss).mockClear();
  vi.restoreAllMocks();
});

describe("isolated preview settings provider", () => {
  it("persists edits in the new separate shared/client envelope and restores them", async () => {
    const first = renderHook(useSettings, { wrapper });
    act(() =>
      first.result.current.update({ theme: "light", sidebarWidth: 300 }),
    );
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({
      formatVersion: "0.1",
      value: { theme: "light" },
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).not.toHaveProperty(
      "client",
    );
    await waitFor(() =>
      expect(
        JSON.parse(sessionStorage.getItem(BROWSER_CLIENT_STATE_KEY)!).state
          .preferences.sidebarWidth,
      ).toBe(300),
    );
    first.unmount();
    const second = renderHook(useSettings, { wrapper });
    expect(second.result.current.settings).toMatchObject({
      theme: "light",
      sidebarWidth: 300,
    });
    await act(() => second.result.current.reset());
    expect(second.result.current.settings).toEqual(DEFAULT_SETTINGS);
  });
  it.each([
    '{"formatVersion":"0.2"}',
    '{"formatVersion":"0.1",',
    JSON.stringify({ ...settingsDocument(DEFAULT_SETTINGS), secret: true }),
  ])(
    "preserves unsupported or corrupt bytes through edits, retry and reset: %s",
    async (raw) => {
      localStorage.setItem(STORAGE_KEY, raw);
      const { result } = renderHook(useSettings, { wrapper });
      act(() => result.current.update({ font: "mono" }));
      act(() => result.current.retrySave());
      await act(async () => {
        await expect(result.current.reset()).rejects.toBeDefined();
      });
      expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
      expect(result.current.settings.font).toBe("mono");
      expect(result.current.persistence).toBe("error");
    },
  );
  it("keeps failed writes in memory and saves the exact explicit edits after retry", async () => {
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw Error("full");
      });
    const { result } = renderHook(useSettings, { wrapper });
    act(() => {
      result.current.update({ accent: "rose" });
      result.current.update({ font: "mono" });
    });
    expect(result.current.persistence).toBe("error");
    expect(result.current.settings).toMatchObject({
      accent: "rose",
      font: "mono",
    });
    write.mockRestore();
    act(() => result.current.retrySave());
    await waitFor(() => expect(result.current.persistence).toBe("saved"));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).value).toMatchObject({
      accent: "rose",
      font: "mono",
    });
  });
});

describe("Host authority subscription", () => {
  it("assembles media on the existing attachment generation and releases native tickets", async () => {
    env.native = true;
    env.connection = {
      generation: "12",
      attachment: { hostId: "host", instanceEpoch: "1" },
    };
    env.backend = {
      read: async () => ({ revision: "3", value: defaults.settings }),
      save: async (value) => ({ revision: "4", value }),
      subscribe: async () => () => {},
    };
    const selected = {
      reference: { hostId: "host", kind: "file", id: "image", revision: "1" },
      name: "sky.png",
      mime: "image/png",
      length: "100",
    };
    env.choose.mockResolvedValue(selected);
    env.resolveMedia.mockResolvedValue({
      ticket: "ticket",
      url: "swb-media://localhost/ticket",
      name: "sky.png",
      mime: "image/png",
    });
    env.releaseMedia.mockResolvedValue(undefined);
    const { result } = renderHook(useSettings, { wrapper });
    await waitFor(() => expect(result.current.persistence).toBe("saved"));
    expect(await result.current.media?.choose()).toEqual(selected);
    expect(env.choose).toHaveBeenCalledWith("media", "12");
    const resource = await result.current.media?.resolve(selected.reference);
    expect(env.resolveMedia).toHaveBeenCalledWith(selected.reference, "12");
    resource?.dispose();
    expect(env.releaseMedia).toHaveBeenCalledWith("ticket", "12");
  });
  it("surfaces attachment failure while retaining edits for a later attachment", async () => {
    env.native = true;
    env.hostError = { code: "HOST_UNAVAILABLE" };
    const { result } = renderHook(useSettings, { wrapper });
    act(() => result.current.update({ language: "en" }));
    await waitFor(() => expect(result.current.persistence).toBe("error"));
    expect(result.current.persistenceError).toBe("HOST_UNAVAILABLE");
    expect(result.current.settings.language).toBe("en");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
  it("StrictMode keeps one live shared subscription and never mirrors Host values to preview storage", async () => {
    env.native = true;
    env.connection = { attachment: { hostId: "host", instanceEpoch: "1" } };
    const listeners = new Set<(snapshot: SettingsSnapshot) => void>();
    let current: SettingsSnapshot = { revision: "3", value: defaults.settings };
    const saved: unknown[] = [];
    env.backend = {
      read: async () => current,
      save: async (value, revision) => {
        saved.push({ value, revision });
        current = { value, revision: "4" };
        return current;
      },
      subscribe: async (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const { result, unmount } = renderHook(useSettings, { wrapper: strict });
    await waitFor(() => expect(listeners.size).toBe(1));
    act(() => result.current.update({ language: "en" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({
      revision: "3",
      value: { language: "en" },
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    act(() => result.current.update({ menuBar: false }));
    await waitFor(() => expect(env.clientWrites).toHaveLength(1));
    expect(env.clientWrites[0]).toMatchObject({
      revision: "2",
      state: {
        preferences: { menuBar: false },
        drafts: { "view-1": "unsent" },
      },
    });
    expect(saved).toHaveLength(1);
    await waitFor(() => expect(env.effects.length).toBeGreaterThan(0));
    unmount();
    expect(listeners.size).toBe(0);
  });
});
