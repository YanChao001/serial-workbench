import type { Cursor, Delta, Snapshot } from "@serial-workbench/contracts";

type ProjectionDisposition = "applied" | "duplicate" | "gap";

function sameScope(a: Cursor, b: Cursor): boolean {
  return (
    a.hostId === b.hostId &&
    a.instanceEpoch === b.instanceEpoch &&
    a.scopeId === b.scopeId
  );
}

/** 接受连续游标；调用者在 gap 后重新取得快照。 */
export function createProjection(snapshot: Snapshot): {
  accept(delta: Delta): ProjectionDisposition;
} {
  let current = snapshot.cursor;
  return {
    accept(delta) {
      const next = delta.cursor;
      const previous = delta.previousCursor;
      if (!sameScope(current, next) || !sameScope(current, previous))
        return "gap";
      const position = BigInt(current.position);
      const nextPosition = BigInt(next.position);
      const previousPosition = BigInt(previous.position);
      if (nextPosition <= previousPosition) return "gap";
      if (nextPosition <= position) return "duplicate";
      if (previousPosition !== position) return "gap";
      current = next;
      return "applied";
    },
  };
}
