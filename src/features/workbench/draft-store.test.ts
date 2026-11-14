import { expect, it } from "vitest";
import { createDraftStore } from "./draft-store";

it("keeps synchronous per-view drafts and tracks exact saved content without serialization", () => {
  const store = createDraftStore({ first: "saved", second: "keep" });
  store.change("first", "saved0");
  store.change("first", "saved00");
  expect(store.snapshot()).toEqual({ first: "saved00", second: "keep" });
  expect(store.isDirty()).toBe(true);
  store.change("first", "saved");
  expect(store.isDirty()).toBe(false);
  store.change("second", "");
  expect(store.get("first")).toBe("saved");
  expect(store.isDirty()).toBe(true);
  store.discard();
  expect(store.get("second")).toBe("keep");
  expect(store.isDirty()).toBe(false);
  expect(store.get("constructor")).toBe("");
});

it("preserves edits made while an older save snapshot is in flight", () => {
  const store = createDraftStore({ first: "A", second: "B" });
  store.change("first", "typed");
  const saving = store.snapshot();
  store.change("first", "typed-more");
  store.change("second", "also edited");
  store.setSaved(saving);
  expect(saving).toEqual({ first: "typed", second: "B" });
  expect(store.snapshot()).toEqual({
    first: "typed-more",
    second: "also edited",
  });
  expect(store.isDirty()).toBe(true);
  store.discard();
  expect(store.snapshot()).toEqual(saving);
  expect(store.isDirty()).toBe(false);
});

it("reidentifies current and saved drafts atomically without confirming newer input", () => {
  const store = createDraftStore({ legacy: "OLD" });
  store.change("legacy", "NEW");
  const observations: { value: string; dirty: boolean }[] = [];
  store.subscribe(() =>
    observations.push({ value: store.get("scoped"), dirty: store.isDirty() }),
  );
  store.reidentify((drafts) => ({ scoped: drafts.legacy! }));
  expect(store.snapshot()).toEqual({ scoped: "NEW" });
  expect(store.isDirty()).toBe(true);
  expect(observations).toEqual([{ value: "NEW", dirty: true }]);
  store.discard();
  expect(store.snapshot()).toEqual({ scoped: "OLD" });
  expect(store.isDirty()).toBe(false);
});

it("preserves a saved empty draft during reidentification and skips unchanged publications", () => {
  const store = createDraftStore({ legacy: "" });
  const observations: { keys: string[]; dirty: boolean }[] = [];
  store.subscribe(() =>
    observations.push({
      keys: Object.keys(store.snapshot()),
      dirty: store.isDirty(),
    }),
  );
  store.reidentify((drafts) => ({ scoped: drafts.legacy! }));
  expect(store.snapshot()).toEqual({ scoped: "" });
  expect(store.isDirty()).toBe(false);
  expect(observations).toEqual([{ keys: ["scoped"], dirty: false }]);
  store.reidentify((drafts) => ({ ...drafts }));
  expect(observations).toHaveLength(1);
});

it("keeps both draft snapshots when an identity transform fails before publication", () => {
  const store = createDraftStore({ legacy: "OLD" });
  store.change("legacy", "NEW");
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  expect(() =>
    store.reidentify((drafts) => {
      if (drafts.legacy === "OLD") throw new Error("Saved draft rejected");
      return { scoped: drafts.legacy! };
    }),
  ).toThrow("Saved draft rejected");
  expect(store.snapshot()).toEqual({ legacy: "NEW" });
  expect(store.isDirty()).toBe(true);
  expect(notifications).toBe(0);
  store.discard();
  expect(store.snapshot()).toEqual({ legacy: "OLD" });
});
