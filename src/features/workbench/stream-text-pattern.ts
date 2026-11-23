export function compileStreamTextPattern(
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): RegExp {
  return new RegExp(
    regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    `gu${caseSensitive ? "" : "i"}`,
  );
}
