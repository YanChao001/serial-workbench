import type { StreamItem, Target } from "@serial-workbench/contracts";
import { expect, test } from "vitest";
import { beginLiveFieldSource } from "./live-field-source";

const target: Target = {
  hostId: "host",
  kind: "session",
  id: "session",
  sessionId: "session",
  sessionEpoch: "3",
};
const origin = 9007199254740993n;
const byte = (offset: number) => String(origin + BigInt(offset));

function rx(
  seq: number,
  offset: number,
  data: number[],
  configurationRevision = "4",
): Extract<StreamItem, { kind: "source" }> {
  return {
    kind: "source",
    event: {
      hostId: target.hostId,
      sessionId: target.id,
      instanceEpoch: "2",
      sessionEpoch: "3",
      configurationRevision,
      eventSeq: String(seq),
      kind: "rx",
      time: {
        sourceMonoNs: String(seq * 1000),
        clockId: "test-clock",
        receivedWallTime: "2026-11-24T00:00:00Z",
        precision: {
          source: "host_read",
          resolutionNs: "1000",
          syncMethod: "none",
        },
      },
      payload: {
        byteStart: byte(offset),
        byteEnd: byte(offset + data.length),
        bytesBase64: btoa(String.fromCharCode(...data)),
      },
    },
  };
}

const start = rx(10, 0, [255, 0, 1, 1, 0]);
const anchor = {
  hex: "00 01 01",
  byteStart: byte(1),
  byteEnd: byte(4),
  eventStart: "10",
  eventEnd: "11",
};

test("live fields continue a verified anchor in the same RX event and across the next one", () => {
  const live = beginLiveFieldSource([start], target, anchor);
  expect(live).toBeDefined();
  expect(live?.update([start])).toEqual({
    kind: "frame",
    frame: anchor,
    pending: 1,
  });
  const second = rx(11, 5, [2, 2]);
  const updated = live?.update([second]);
  expect(updated).toEqual({
    kind: "frame",
    frame: {
      hex: "00 02 02",
      byteStart: byte(4),
      byteEnd: byte(7),
      eventStart: "10",
      eventEnd: "12",
    },
    pending: 0,
  });
  expect(live?.update([second])).toBe(updated);
  if (updated?.kind !== "frame") throw new Error("Expected a complete frame");
  const selection = live?.selection([start, second], updated.frame);
  expect(selection).toMatchObject({
    hex: "00 02 02",
    range: {
      start: { offset: origin + 4n },
      end: { offset: origin + 7n },
    },
  });
  expect(live?.selection([second], updated.frame)).toBeUndefined();
});

test("a burst retains the last complete frame and leaves an incomplete tail pending", () => {
  const live = beginLiveFieldSource([start], target, anchor);
  const burst = rx(11, 5, [
    2,
    2,
    ...Array(129).fill([0, 3, 3]).flat(),
    0,
    4,
    4,
    1,
  ]);
  expect(live?.update([start, burst])).toEqual({
    kind: "frame",
    frame: {
      hex: "00 04 04",
      byteStart: byte(394),
      byteEnd: byte(397),
      eventStart: "11",
      eventEnd: "12",
    },
    pending: 1,
  });
});

test("live fields reject a mismatched anchor and permanently clear on gaps or configuration changes", () => {
  expect(
    beginLiveFieldSource([start], target, { ...anchor, hex: "00 09 09" }),
  ).toBeUndefined();
  const gap: StreamItem = {
    kind: "reader_gap",
    gap: {
      hostId: "host",
      instanceEpoch: "2",
      sessionId: "session",
      sessionEpoch: "3",
      reason: "reader_overflow",
      missingEventRange: { start: "11", end: "12" },
    },
  };
  const live = beginLiveFieldSource([start], target, anchor);
  expect(live?.update([start, gap])).toEqual({ kind: "source_changed" });
  expect(live?.update([start, rx(11, 5, [2, 2])])).toEqual({
    kind: "source_changed",
  });

  const changed = beginLiveFieldSource([start], target, anchor);
  expect(changed?.update([rx(11, 5, [2, 2], "5")])).toEqual({
    kind: "source_changed",
  });

  const missing = beginLiveFieldSource([start], target, anchor);
  expect(missing?.update([rx(12, 5, [2, 2])])).toEqual({
    kind: "source_changed",
  });
});
