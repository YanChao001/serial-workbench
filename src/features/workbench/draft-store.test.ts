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
