import type { StateScopeRef } from "@serial-workbench/contracts";

/** 查询、投影和原生命令的 JSON 字段顺序不属于资源身份。 */
export function stateScopeKey(scope: StateScopeRef | undefined): string {
  if (!scope) return "";
  const target = scope.target;
  return JSON.stringify([
    scope.scopeId,
    target.hostId,
    target.kind,
    target.id,
    target.sessionId,
    target.sessionEpoch,
  ]);
}
