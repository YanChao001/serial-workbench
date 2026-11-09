import { expect, it } from "vitest";
import type { RawEvent, StreamItem } from "@serial-workbench/contracts";
import { presentStreamTimes } from "./stream-presentation";

function source(ns: string, clockId = "clock"): StreamItem {
  const event: RawEvent = {
    hostId: "host",
    instanceEpoch: "1",
    sessionId: "session",
    sessionEpoch: "1",
    eventSeq: "1",
    configurationRevision: "1",
    time: {
      clockId,
      sourceMonoNs: ns,
      receivedWallTime: "2026-11-08T00:00:00Z",
      precision: {
        source: "host_read",
        resolutionNs: "1000000",
        syncMethod: "none",
      },
    },
    kind: "rx",
    payload: { bytesBase64: "QQ==", byteStart: "0", byteEnd: "1" },
  };
  return { kind: "source", event };
}

it("subtracts U64 timestamps without losing nanoseconds above Number precision", () => {
  const times = presentStreamTimes([
    source("9007199254740993"),
    source("9007199254741000"),
  ]);
  expect(times[1]).toMatchObject({
    relativeNs: "7",
    intervalNs: "7",
    absolute: "2026-11-08T00:00:00Z",
    absoluteSource: "received",
  });
});

it("starts a new relative origin when a replay seeks backwards on the same clock", () => {
  const times = presentStreamTimes([source("30"), source("10"), source("15")]);
  expect(times[1]).toMatchObject({ relativeNs: "0", intervalNs: null });
  expect(times[2]).toMatchObject({ relativeNs: "5", intervalNs: "5" });
});

it("marks missing time and refuses intervals across a reader gap or a different clock", () => {
  const gap: StreamItem = {
    kind: "reader_gap",
    gap: {
      hostId: "host",
      instanceEpoch: "1",
      sessionId: "session",
      sessionEpoch: "1",
      reason: "reader_overflow",
      missingEventRange: { start: "1", end: "2" },
    },
  };
  const times = presentStreamTimes([
    source("10"),
    gap,
    source("20"),
    source("30", "other"),
  ]);
  expect(times[1]).toMatchObject({ absolute: null, intervalNs: null });
  expect(times[2]).toMatchObject({ relativeNs: "10", intervalNs: null });
  expect(times[3]).toMatchObject({ relativeNs: "0", intervalNs: null });
});

it("uses source wall time when supplied and refuses an interval over a source gap or epoch", () => {
  const first = source("10");
  if (first.kind !== "source") throw new Error("Expected a source event");
  const timestamped: StreamItem = {
    ...first,
    event: {
      ...first.event,
      time: {
        ...first.event.time,
        sourceWallTime: "2026-11-07T23:59:59.999999999Z",
      },
    },
  };
  const gap: StreamItem = {
    ...first,
    event: {
      ...first.event,
      kind: "gap",
      payload: {
        reason: "backend_loss",
        knownExtent: true,
        missingByteRange: { direction: "rx", start: "1", end: "3" },
      },
    },
  };
  const epoch: StreamItem = {
    ...first,
    event: { ...first.event, sessionEpoch: "2" },
  };
  const times = presentStreamTimes([timestamped, gap, source("30"), epoch]);
  expect(times[0]).toMatchObject({
    absolute: "2026-11-07T23:59:59.999999999Z",
    absoluteSource: "source",
  });
  expect(times[1]!.intervalNs).toBeNull();
  expect(times[2]!.intervalNs).toBeNull();
  expect(times[3]).toMatchObject({ relativeNs: "0", intervalNs: null });
});
