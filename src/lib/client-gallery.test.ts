import { describe, expect, it, vi } from "vitest";
import type {
  ClientStateSnapshot_Serialize as ClientStateSnapshot,
  GalleryEntry,
} from "./generated/bindings";
import { DEFAULT_CLIENT_STATE } from "./client-settings";
import { createClientGallery } from "./client-gallery";

const entry: GalleryEntry = {
  reference: { hostId: "host", kind: "file", id: "image", revision: "1" },
  name: "Sky",
};
function setup() {
  let current: ClientStateSnapshot = {
    formatVersion: "0.1",
    revision: "1",
    state: structuredClone(DEFAULT_CLIENT_STATE),
  };
  const read = vi.fn(async () => current);
  const save = vi.fn(
    async (state: ClientStateSnapshot["state"], revision: string) => {
      if (revision !== current.revision) throw { code: "CONFLICT" };
      current = { ...current, state, revision: String(BigInt(revision) + 1n) };
      return current;
    },
  );
  return {
    store: createClientGallery({ read, save }),
    read,
    save,
    get: () => current,
    set: (next: ClientStateSnapshot) => {
      current = next;
    },
  };
}
describe("client gallery metadata CAS", () => {
  it("merges a concurrent preference/draft write and stores only pinned references with names", async () => {
    const env = setup();
    env.save.mockImplementationOnce(async () => {
      env.set({
        formatVersion: "0.1",
        revision: "2",
        state: {
          ...DEFAULT_CLIENT_STATE,
          preferences: {
            ...DEFAULT_CLIENT_STATE.preferences,
            sidebarWidth: 300,
          },
          drafts: { view: "unsent" },
        },
      });
      throw { code: "CONFLICT" };
    });
    expect(await env.store.upsert(entry)).toEqual([entry]);
    expect(env.get().state).toMatchObject({
      preferences: { sidebarWidth: 300 },
      drafts: { view: "unsent" },
      gallery: [entry],
    });
    expect(env.save).toHaveBeenCalledTimes(2);
  });
  it("updates a reimported identity instead of duplicating it and renames/removes metadata only", async () => {
    const env = setup();
    await env.store.upsert(entry);
    const newer = {
      ...entry,
      reference: { ...entry.reference, revision: "2" },
      name: "Cloud",
    };
    expect(await env.store.upsert(newer)).toEqual([newer]);
    expect(await env.store.rename(newer.reference, "New name")).toEqual([
      { ...newer, name: "New name" },
    ]);
    expect(await env.store.remove(newer.reference)).toEqual([]);
    expect(env.get().state.preferences).toEqual(
      DEFAULT_CLIENT_STATE.preferences,
    );
  });
  it("does not default-overwrite unreadable or future client state", async () => {
    const env = setup();
    env.read.mockRejectedValueOnce({ code: "STORAGE_CORRUPT" });
    await expect(env.store.upsert(entry)).rejects.toMatchObject({
      code: "STORAGE_CORRUPT",
    });
    env.set({ ...env.get(), formatVersion: "0.2" });
    await expect(env.store.upsert(entry)).rejects.toMatchObject({
      code: "STORAGE_CORRUPT",
    });
    expect(env.save).not.toHaveBeenCalled();
  });
  it("bounds conflict retries and respects cancellation before any write", async () => {
    const env = setup();
    env.save.mockRejectedValue({ code: "CONFLICT" });
    await expect(env.store.upsert(entry)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(env.save).toHaveBeenCalledTimes(3);
    env.save.mockClear();
    const controller = new AbortController();
    controller.abort();
    await expect(
      env.store.upsert(entry, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(env.save).not.toHaveBeenCalled();
  });
});
