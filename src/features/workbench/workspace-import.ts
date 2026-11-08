import type { WorkspaceDocument } from "@serial-workbench/contracts";

export type WorkspaceImportChange = {
  section: keyof WorkspaceDocument;
  key: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
};

function sameValue(before: unknown, after: unknown): boolean {
  if (Object.is(before, after)) return true;
  if (Array.isArray(before) && Array.isArray(after))
    return (
      before.length === after.length &&
      before.every((value, index) => sameValue(value, after[index]))
    );
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object"
  ) {
    const left = Object.entries(before);
    const right = Object.entries(after);
    return (
      left.length === right.length &&
      left.every(
        ([key, value]) =>
          Object.hasOwn(after, key) &&
          sameValue(value, Reflect.get(after, key)),
      )
    );
  }
  return false;
}

/** 候选已由 Host 校验；这里只比较草稿与候选，不解析或验证导入格式。 */
export function diffWorkspaceImport(
  draft: WorkspaceDocument,
  candidate: WorkspaceDocument,
): WorkspaceImportChange[] {
  const changes: WorkspaceImportChange[] = [];
  function compare(
    section: keyof WorkspaceDocument,
    key: string,
    before: unknown,
    after: unknown,
  ) {
    if (!sameValue(before, after))
      changes.push({ section, key, kind: "changed", before, after });
  }
  function collection<T>(
    section: keyof WorkspaceDocument,
    before: T[],
    after: T[],
    identity: (value: T) => string,
  ) {
    const previous = new Map(before.map((value) => [identity(value), value]));
    const next = new Map(after.map((value) => [identity(value), value]));
    for (const [key, value] of previous) {
      if (!next.has(key))
        changes.push({ section, key, kind: "removed", before: value });
      else compare(section, key, value, next.get(key));
    }
    for (const [key, value] of next)
      if (!previous.has(key))
        changes.push({ section, key, kind: "added", after: value });
    compare(section, "$order", before.map(identity), after.map(identity));
  }
  compare("name", "name", draft.name, candidate.name);
  collection("views", draft.views, candidate.views, (view) => view.id);
  collection(
    "bindings",
    draft.bindings,
    candidate.bindings,
    (binding) => binding.bindingId,
  );
  collection(
    "favoriteBindingIds",
    draft.favoriteBindingIds,
    candidate.favoriteBindingIds,
    (id) => id,
  );
  for (const key of ["sidebarWidth", "panelHeight"] as const)
    compare("layout", key, draft.layout[key], candidate.layout[key]);
  collection(
    "captures",
    draft.captures,
    candidate.captures,
    (capture) => `${capture.hostId}/${capture.kind}/${capture.id}`,
  );
  return changes;
}
