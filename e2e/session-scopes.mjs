export function sessionScopes(scopes) {
  return scopes.filter(
    ({ scopeId, target }) =>
      target.kind === "session" && scopeId === `session:${target.id}`,
  );
}
