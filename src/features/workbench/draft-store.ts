type Drafts = Readonly<Record<string, string>>;
type DraftUpdate = Drafts | ((current: Drafts) => Drafts);

function sameDrafts(left: Drafts, right: Drafts) {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

/** 每个工作台独立持有；正文同步更新，订阅者只在自己的快照变化时重绘。 */
export function createDraftStore(initial: Drafts) {
  let current: Drafts = { ...initial };
  let saved: Drafts = current;
  let dirty = false;
  const listeners = new Set<() => void>();
  const publish = () => {
    dirty = !sameDrafts(current, saved);
    for (const listener of listeners) listener();
  };
  const update = (value: DraftUpdate) => {
    const next = typeof value === "function" ? value(current) : value;
    if (sameDrafts(current, next)) return;
    current = { ...next };
    publish();
  };
  return {
    snapshot: () => current,
    get: (key: string) => (Object.hasOwn(current, key) ? current[key]! : ""),
    isDirty: () => dirty,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update,
    change: (key: string, value: string) =>
      update({ ...current, [key]: value }),
    setSaved: (value: DraftUpdate) => {
      const next = typeof value === "function" ? value(saved) : value;
      if (sameDrafts(saved, next)) return;
      saved = { ...next };
      publish();
    },
    discard: () => update(saved),
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;
