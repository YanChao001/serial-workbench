import { expect, it, vi } from "vitest";
import type { ClientStateSnapshot } from "@/lib/tauri";
import { createClientDraftStore } from "./client-drafts";

const snapshot = (
  revision: string,
  collapsed = false,
): ClientStateSnapshot => ({
  formatVersion: "0.1",
  revision,
  state: {
    gallery: [],
    preferences: {
      menuBar: true,
      windowPosition: "remember",
      sidebarCollapsed: collapsed,
      sidebarWidth: 224,
    },
    currentPage: "workbench",
    focusedPanelId: null,
    scrollOffset: 0,
    follow: true,
    lastWorkspaceId: "default",
    drafts: { view: "old" },
  },
});
it("retries a revision conflict against fresh state and preserves changed preferences", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(snapshot("1"))
    .mockResolvedValueOnce(snapshot("2", true));
  const save = vi
    .fn()
    .mockRejectedValueOnce({ code: "CONFLICT" })
    .mockResolvedValue(snapshot("3", true));
  await createClientDraftStore({ read, save }).save({ view: "AT?" });
  expect(save).toHaveBeenLastCalledWith(
    { ...snapshot("2", true).state, drafts: { view: "AT?" } },
    "2",
  );
});
it("does not write over a future format", async () => {
  const save = vi.fn();
  const store = createClientDraftStore({
    read: vi
      .fn()
      .mockResolvedValueOnce(snapshot("1"))
      .mockResolvedValue({ ...snapshot("2"), formatVersion: "9.0" }),
    save,
  });
  await store.read();
  await expect(store.save({ view: "draft" })).rejects.toThrow("FUTURE_FORMAT");
  expect(save).not.toHaveBeenCalled();
});

it("shares initial restoration while cancelling only the caller's wait", async () => {
  let complete!: (value: ClientStateSnapshot) => void;
  const read = vi.fn(
    () =>
      new Promise<ClientStateSnapshot>((resolve) => {
        complete = resolve;
      }),
  );
  const store = createClientDraftStore({ read, save: vi.fn() });
  const controller = new AbortController();
  const cancelled = store.read(controller.signal);
  const active = store.read();
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  complete(snapshot("1"));
  expect(await active).toEqual({ view: "old" });
  expect(await store.read()).toEqual({ view: "old" });
  expect(read).toHaveBeenCalledTimes(1);
});

it("retries failed restoration without caching an empty draft", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce({ code: "STORAGE_CORRUPT" })
    .mockResolvedValue(snapshot("1"));
  const store = createClientDraftStore({ read, save: vi.fn() });
  await expect(store.read()).rejects.toMatchObject({ code: "STORAGE_CORRUPT" });
  expect(store.getSnapshot()).toBeUndefined();
  expect(await store.read()).toEqual({ view: "old" });
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps the newer saved drafts when an older initial read arrives late", async () => {
  let complete!: (value: ClientStateSnapshot) => void;
  const initial = new Promise<ClientStateSnapshot>((resolve) => {
    complete = resolve;
  });
  const newer = snapshot("2");
  newer.state.drafts = { view: "new" };
  const store = createClientDraftStore({
    read: vi.fn().mockReturnValueOnce(initial).mockResolvedValue(snapshot("1")),
    save: vi.fn().mockResolvedValue(newer),
  });
  const pending = store.read();
  await store.save({ view: "new" });
  complete(snapshot("1"));
  expect(await pending).toEqual({ view: "new" });
  const visible = store.getSnapshot()!;
  visible.view = "changed by caller";
  expect(await store.read()).toEqual({ view: "new" });
});

it("remembers a real save receipt after its caller stopped waiting", async () => {
  let complete!: (value: ClientStateSnapshot) => void;
  const save = vi.fn(
    () =>
      new Promise<ClientStateSnapshot>((resolve) => {
        complete = resolve;
      }),
  );
  const store = createClientDraftStore({
    read: vi.fn().mockResolvedValue(snapshot("1")),
    save,
  });
  await store.read();
  const controller = new AbortController();
  const pending = store.save({ view: "committed" }, controller.signal);
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const saved = snapshot("2");
  saved.state.drafts = { view: "committed" };
  complete(saved);
  await vi.waitFor(() =>
    expect(store.getSnapshot()).toEqual({ view: "committed" }),
  );
});
it("aborting a pending read releases the wait without starting a save", async () => {
  const save = vi.fn();
  const controller = new AbortController();
  const store = createClientDraftStore({
    read: () => new Promise<ClientStateSnapshot>(() => {}),
    save,
  });
  const pending = store.save({ view: "draft" }, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(save).not.toHaveBeenCalled();
});
