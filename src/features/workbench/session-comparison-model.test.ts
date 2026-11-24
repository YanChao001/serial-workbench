import { expect, test } from "vitest";
import type { CaptureRecord, RawEvent } from "@serial-workbench/contracts";
import { compileProtocolFields } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import {
  compareSessionFrames,
  type ComparisonFrame,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/session-comparison";
import { replayComparisonFrames } from "./session-comparison-model";

const firstNs = 9_007_199_254_740_993n;

function frame(
  position: number,
  bytes: number[],
  offset: bigint,
  clockId = "a-clock",
  segment = 0,
): ComparisonFrame {
  return {
    position: BigInt(position),
    bytes: new Uint8Array(bytes),
    time: { clockId, monoNs: firstNs + offset, segment },
  };
}

const codec = compileProtocolFields({
  version: "1",
  byteLength: 3,
  fields: ["unit", "register", "value"].map((id, byteOffset) => ({
    id,
    kind: "integer",
    byteOffset,
    width: 1,
    order: "big",
  })),
});

test("ordinal alignment preserves gaps and reports exact byte intervals", () => {
  const left = [frame(1, [1, 2, 3, 4], 0n), frame(3, [9], 30n)];
  const right = [
    frame(1, [1, 8, 3, 6, 7], 100n, "b-clock"),
    frame(2, [5], 109n, "b-clock"),
    frame(3, [9], 130n, "b-clock"),
  ];
  const rows = compareSessionFrames(left, right, { kind: "ordinal" });
  expect(rows.map((row) => [row.left?.position, row.right?.position])).toEqual([
    [1n, 1n],
    [3n, 3n],
    [undefined, 2n],
  ]);
  expect(rows[0]).toMatchObject({
    bytes: {
      count: 3,
      ranges: [
        { start: 1, end: 2 },
        { start: 3, end: 5 },
      ],
    },
    elapsedDeltaNs: 0n,
  });
  expect(rows[0]?.fields).toBeUndefined();
  expect(rows[1]?.bytes?.count).toBe(0);
  expect(rows[2]?.bytes).toBeUndefined();
});

test("byte-prefix alignment pairs repeated keys by occurrence and keeps unavailable keys", () => {
  const left = [
    frame(1, [1, 2, 3], 0n),
    frame(2, [1, 2, 4], 1n),
    frame(3, [7], 2n),
  ];
  const right = [
    frame(1, [9, 9], 0n),
    frame(2, [1, 2, 3], 1n),
    frame(3, [1, 2, 8], 2n),
    frame(4, [1, 2, 6], 3n),
  ];
  const rows = compareSessionFrames(left, right, { kind: "prefix", length: 2 });
  expect(
    rows.map(({ left: a, right: b, keyAvailable, repeatedKey }) => [
      a?.position,
      b?.position,
      keyAvailable,
      repeatedKey,
    ]),
  ).toEqual([
    [1n, 2n, true, true],
    [2n, 3n, true, true],
    [3n, undefined, false, false],
    [undefined, 1n, true, false],
    [undefined, 4n, true, true],
  ]);
});

test("multi-field alignment separates field changes from bytes and relative clock drift", () => {
  const left = [
    frame(1, [1, 8, 99], 0n),
    frame(2, [2, 8, 11], 12n),
    frame(3, [2, 7, 13], 21n),
  ];
  const right = [
    frame(1, [1, 8, 99], 1000n, "b-clock"),
    frame(2, [2, 7, 13], 1004n, "b-clock"),
    frame(3, [2, 8, 77], 1011n, "b-clock"),
    frame(4, [2, 9], 1016n, "b-clock"),
  ];
  const rows = compareSessionFrames(
    left,
    right,
    { kind: "fields", ids: ["unit", "register"] },
    codec,
  );
  expect(rows.map((row) => row.right?.position)).toEqual([1n, 3n, 2n, 4n]);
  expect(rows[1]).toMatchObject({
    bytes: { count: 1, ranges: [{ start: 2, end: 3 }] },
    fields: [{ id: "value", left: { value: "11" }, right: { value: "77" } }],
    elapsedDeltaNs: -1n,
  });
  expect(rows[2]).toMatchObject({
    bytes: { count: 0 },
    fields: [],
    elapsedDeltaNs: -17n,
  });
  expect(rows[3]?.keyAvailable).toBe(false);
  expect(rows[3]?.right?.decodeFailure).toBeDefined();
});

test("after a source gap or nonmonotonic time the byte comparison stays available", () => {
  const left = [
    frame(1, [1], 0n),
    frame(2, [2], 1n),
    frame(3, [3], 100n, "a-clock", 1),
    frame(4, [4], 111n, "a-clock", 1),
  ];
  const right = [
    frame(1, [1], 0n),
    frame(2, [5], 2n),
    frame(3, [3], 1n),
    frame(4, [4], 4n),
  ];
  const rows = compareSessionFrames(left, right, { kind: "ordinal" });
  expect(rows.map((row) => row.elapsedDeltaNs)).toEqual([
    0n,
    1n,
    undefined,
    undefined,
  ]);
  expect(rows.map((row) => row.bytes?.count)).toEqual([0, 1, 0, 0]);
});

test("comparison refuses invalid bounds and observes a cancelled analysis", () => {
  const first = frame(1, [1], 0n);
  expect(() =>
    compareSessionFrames([first, first], [], { kind: "ordinal" }),
  ).toThrow(RangeError);
  expect(() =>
    compareSessionFrames([], [], { kind: "prefix", length: 0 }),
  ).toThrow(RangeError);
  expect(() =>
    compareSessionFrames(
      [],
      [],
      { kind: "fields", ids: ["unit", "unit"] },
      codec,
    ),
  ).toThrow(RangeError);
  const full = Array.from({ length: 17 }, (_, index) => ({
    ...first,
    position: BigInt(index + 1),
    bytes: new Uint8Array(4096),
  }));
  expect(() => compareSessionFrames(full, [], { kind: "ordinal" })).toThrow(
    RangeError,
  );
  expect(() =>
    compareSessionFrames(
      [],
      [],
      { kind: "ordinal" },
      undefined,
      AbortSignal.abort(),
    ),
  ).toThrow();
});

const origin = {
  hostId: "recorded-host",
  instanceEpoch: "1",
  sessionId: "recorded-session",
  sessionEpoch: "2",
};
const firstByte = 9_007_199_254_741_000n;
function rx(
  seq: number,
  recordOrdinal: string,
  byte: number,
  data: number[],
): Extract<RawEvent, { kind: "rx" }> & {
  recordOrdinal: string;
} {
  return {
    ...origin,
    recordOrdinal,
    configurationRevision: "1",
    eventSeq: String(seq),
    time: {
      sourceMonoNs: String(firstNs + BigInt(seq)),
      clockId: "recorded-clock",
      receivedWallTime: "2026-11-24T00:00:00Z",
      precision: { source: "host_read", resolutionNs: "1", syncMethod: "none" },
    },
    kind: "rx",
    payload: {
      bytesBase64: btoa(String.fromCharCode(...data)),
      byteStart: String(firstByte + BigInt(byte)),
      byteEnd: String(firstByte + BigInt(byte + data.length)),
    },
  };
}
function record({
  recordOrdinal,
  ...value
}: ReturnType<typeof rx>): CaptureRecord {
  return { recordOrdinal, entry: { kind: "event", value } };
}

test("replay projections retain split frame provenance and skip missing physical positions", () => {
  const first = rx(5, "40", 0, [1]);
  const records: CaptureRecord[] = [
    record(first),
    record(rx(6, "41", 1, [2, 3, 4])),
    {
      recordOrdinal: "42",
      entry: {
        kind: "reader_gap",
        value: {
          ...origin,
          reason: "capture_overflow",
          missingEventRange: { start: "7", end: "8" },
          missingByteRanges: [
            {
              direction: "rx",
              start: String(firstByte + 4n),
              end: String(firstByte + 6n),
            },
          ],
        },
      },
    },
    record(rx(8, "43", 6, [7, 8])),
  ];
  const capture = replayComparisonFrames(records, first, firstByte, 2);
  expect(capture?.gap).toBe(true);
  expect(capture?.frames.map(({ position }) => position)).toEqual([1n, 2n, 4n]);
  expect(capture?.frames[0]).toMatchObject({
    bytes: Uint8Array.of(1, 2),
    time: { monoNs: firstNs + 6n, segment: 0 },
    source: {
      eventStart: "5",
      eventEnd: "7",
      byteStart: String(firstByte),
      byteEnd: String(firstByte + 2n),
      firstRecord: "40",
      lastRecord: "41",
    },
  });
  expect(capture?.frames.at(-1)).toMatchObject({
    time: { monoNs: firstNs + 8n, segment: 1 },
    source: { firstRecord: "43", lastRecord: "43" },
  });
  const comparisons = compareSessionFrames(capture!.frames, capture!.frames, {
    kind: "ordinal",
  });
  expect(comparisons.map((row) => row.elapsedDeltaNs)).toEqual([
    0n,
    0n,
    undefined,
  ]);
});
