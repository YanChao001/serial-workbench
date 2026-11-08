import { describe, expect, it } from "vitest";
import type { Delta, Snapshot } from "@serial-workbench/contracts";
import { createProjection } from "./projection";

const cursor = (position: string, instanceEpoch = "7") => ({
  hostId: "host",
  instanceEpoch,
  scopeId: "host.devices",
  position,
});
const snapshot: Snapshot = {
  hostId: "host",
  instanceEpoch: "7",
  revision: "1",
  cursor: cursor("1"),
  state: {},
};
const delta = (previous: string, next: string): Delta => ({
  previousCursor: cursor(previous),
  cursor: cursor(next),
  revision: next,
  eventType: "changed",
  payload: {},
});

describe("projection cursor continuity", () => {
  it("applies contiguous deltas once and reports a missing range", () => {
    const projection = createProjection(snapshot);
    expect(projection.accept(delta("1", "2"))).toBe("applied");
    expect(projection.accept(delta("1", "2"))).toBe("duplicate");
    expect(projection.accept(delta("3", "4"))).toBe("gap");
  });
  it("rejects an old Host epoch rather than applying it", () => {
    const projection = createProjection(snapshot);
    expect(
      projection.accept({ ...delta("1", "2"), cursor: cursor("2", "6") }),
    ).toBe("gap");
  });
});
