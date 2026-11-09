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
    read: async () => ({ ...snapshot("1"), formatVersion: "9.0" }),
    save,
  });
  await expect(store.save({ view: "draft" })).rejects.toThrow("FUTURE_FORMAT");
  expect(save).not.toHaveBeenCalled();
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
