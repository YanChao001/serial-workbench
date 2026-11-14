/** 工作区范围必须稳定跨重连；保留的斜杠前缀不与 Host 视图 ID 相交。 */
export function viewDraftKey(
  scope: string | undefined,
  viewId: string,
): string {
  if (scope !== undefined) return `view/${JSON.stringify([scope, viewId])}`;
  return viewId === "unconnected" ? "view/unconnected" : viewId;
}

/** 只认领当前视图的旧身份；已有归属优先，未认领的原稿继续保留。 */
export function restoreViewDraftIdentity(
  drafts: Readonly<Record<string, string>>,
  workspace: { views: readonly { id: string }[] } | undefined,
  initialUnconnected: string | undefined,
  scope: string | undefined,
): Readonly<Record<string, string>> {
  // 旧窗口稿只初始化首次归属；本轮其他视图的迁移顺序不能改变该判断。
  const initializeUnconnected = !Object.keys(drafts).some((key) =>
    key.startsWith("view/["),
  );
  let restored: Record<string, string> | undefined;
  for (const { id } of workspace?.views ?? []) {
    const key = viewDraftKey(scope, id);
    const current = restored ?? drafts;
    if (Object.hasOwn(current, key)) continue;
    const legacy = viewDraftKey(undefined, id);
    if (Object.hasOwn(current, legacy)) {
      restored ??= { ...drafts };
      restored[key] = current[legacy]!;
      delete restored[legacy];
    } else if (
      initializeUnconnected &&
      id === "unconnected" &&
      initialUnconnected !== undefined
    ) {
      // 旧窗口草稿可初始化同名文档视图，但始终保留窗口原稿。
      restored ??= { ...drafts };
      restored[key] = initialUnconnected;
    }
  }
  return restored ?? drafts;
}
