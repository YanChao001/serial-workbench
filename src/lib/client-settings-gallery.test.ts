import { describe, expect, it } from "vitest";
import generatedDefaults from "./generated/client-defaults.json";

const reference = { hostId: "host", kind: "file", id: "image", revision: "1" };
const entry = { reference, name: "  Photo  " };

describe("Rust-generated client gallery state", () => {
  it("loads the actual generated defaults with an explicit empty gallery", async () => {
    await expect(import("./client-settings")).resolves.toMatchObject({
      DEFAULT_CLIENT_STATE: generatedDefaults,
    });
  }, 30000);

  it("roundtrips pinned media with a 120-character Unicode name and preserves drafts", async () => {
    const { parseClientWindowState } = await import("./client-settings");
    const gallery = Array.from({ length: 24 }, (_, index) => ({
      reference: { ...reference, id: "image-" + index },
      name: "\u{1f324}".repeat(120),
    }));
    const value = { ...generatedDefaults, gallery, drafts: { view: "unsent" } };
    expect(parseClientWindowState(value)).toEqual(value);
    const whitespaceName = { ...generatedDefaults, gallery: [entry] };
    expect(parseClientWindowState(whitespaceName)).toEqual(whitespaceName);
  });

  it.each(
    [
      null,
      {},
      [null],
      [{ ...entry, path: "C:/private.png" }],
      [{ ...entry, reference: { ...reference, bytes: [1, 2] } }],
      [{ ...entry, reference: { ...reference, id: "../private" } }],
      [{ ...entry, reference: { ...reference, revision: "01" } }],
      [
        {
          ...entry,
          reference: { ...reference, revision: "18446744073709551616" },
        },
      ],
      Array.from({ length: 25 }, (_, index) => ({
        ...entry,
        reference: { ...reference, id: "image-" + index },
      })),
    ].map((gallery) => ({ gallery })),
  )("rejects malformed gallery metadata: %j", async ({ gallery }) => {
    const { parseClientWindowState } = await import("./client-settings");
    expect(() =>
      parseClientWindowState({ ...generatedDefaults, gallery }),
    ).toThrow();
  });

  it("rejects the former client shape rather than silently discarding gallery state", async () => {
    const { parseClientWindowState } = await import("./client-settings");
    const former: Record<string, unknown> = { ...generatedDefaults };
    delete former.gallery;
    expect(() => parseClientWindowState(former)).toThrow();
  });

  it("preserves corrupt gallery bytes and keeps gallery during a preference save", async () => {
    const { createBrowserClientStateStore, DEFAULT_CLIENT_STATE } =
      await import("./client-settings");
    const key = "client-gallery-test";
    const storage = sessionStorage;
    storage.removeItem(key);
    const store = createBrowserClientStateStore(
      storage,
      key,
      DEFAULT_CLIENT_STATE,
    );
    const first = store.save(
      { ...DEFAULT_CLIENT_STATE, gallery: [entry] },
      "0",
    );
    const second = store.save(
      {
        ...first.state,
        preferences: { ...first.state.preferences, menuBar: false },
      },
      first.revision,
    );
    expect(store.read().state.gallery).toEqual([entry]);
    const corrupt = JSON.stringify({
      ...second,
      state: {
        ...second.state,
        gallery: [{ ...entry, dataUrl: "data:image/png;base64,AAAA" }],
      },
    });
    storage.setItem(key, corrupt);
    expect(() => store.read()).toThrow();
    expect(() => store.save(second.state, second.revision)).toThrow();
    expect(storage.getItem(key)).toBe(corrupt);
    storage.removeItem(key);
  });
});
