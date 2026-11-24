import type { RawEvent, StreamItem, Target } from "@serial-workbench/contracts";
import { expect, test } from "vitest";
import { compileProtocolFields } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import { busLoad } from "./bus-load-model";

const target: Target = {
  kind: "session",
  hostId: "bus-host",
  id: "bus-session",
  sessionId: "bus-session",
  sessionEpoch: "7",
};
const origin = 9007199254740993n;

function event(seq: number, ms: number) {
  return {
    hostId: target.hostId,
    sessionId: target.id,
    sessionEpoch: "7",
    instanceEpoch: "3",
    eventSeq: String(seq),
    configurationRevision: "1",
    time: {
      sourceMonoNs: String(origin + BigInt(ms) * 1000000n),
      clockId: "bus-clock",
      receivedWallTime: "2026-11-24T00:00:00Z",
      precision: {
        source: "host_read" as const,
        resolutionNs: "1000",
        syncMethod: "none",
      },
    },
  };
}

function source(value: RawEvent): StreamItem {
  return { kind: "source", event: value };
}

function rx(seq: number, ms: number, start: number, data: number[]) {
  return source({
    ...event(seq, ms),
    kind: "rx",
    payload: {
      bytesBase64: btoa(String.fromCharCode(...data)),
      byteStart: String(start),
      byteEnd: String(start + data.length),
    },
  });
}

const codec = compileProtocolFields({
  version: "1",
  byteLength: 3,
  fields: [
    {
      id: "sum",
      kind: "checksum",
      byteOffset: 2,
      order: "big",
      algorithm: "sum",
      coverageStart: 0,
      coverageEnd: 2,
    },
  ],
});
const frame = {
  hex: "01 02 03",
  byteStart: "0",
  byteEnd: "3",
  eventStart: "1",
  eventEnd: "3",
};

test("bus windows count confirmed TX once and separate RX, invalid frames and partial coverage", () => {
  const intent = {
    operationId: "send",
    byteStart: "0",
    byteEnd: "3",
    bytesBase64: "CQgH",
  };
  const items = [
    rx(1, 0, 0, [1, 2]),
    rx(2, 10, 2, [3]),
    source({ ...event(3, 20), kind: "tx_intent", payload: intent }),
    source({
      ...event(4, 50),
      kind: "tx",
      payload: {
        ...intent,
        sessionId: target.id,
        sessionEpoch: "7",
        outcome: "unknown",
        peerAcknowledged: false,
        acceptedRanges: [{ start: "0", end: "2" }],
        unknownRanges: [{ start: "2", end: "3" }],
      },
    }),
    rx(5, 100, 3, [4, 5, 0]),
    source({ ...event(6, 200), kind: "control", payload: {} }),
  ];
  const model = busLoad(
    {
      target,
      items,
      endEventSeq: "7",
      frames: [
        frame,
        {
          hex: "04 05 00",
          byteStart: "3",
          byteEnd: "6",
          eventStart: "5",
          eventEnd: "6",
        },
      ],
    },
    100,
    codec,
  );
  expect(model).toMatchObject({
    origin: String(origin),
    observedThrough: String(origin + 200000000n),
    hasCodec: true,
    unresolved: 0,
  });
  expect(model?.buckets).toMatchObject([
    {
      offsetMs: 0n,
      receivedBytes: 3n,
      acceptedBytes: 2n,
      unknownBytes: 1n,
      parsedFrames: 1,
      failedFrames: 0,
      complete: true,
      framesComplete: true,
    },
    {
      offsetMs: 100n,
      receivedBytes: 3n,
      acceptedBytes: 0n,
      parsedFrames: 1,
      failedFrames: 1,
      complete: true,
      framesComplete: true,
    },
    { offsetMs: 200n, complete: false, framesComplete: false },
  ]);
});

test("retention gaps and unavailable frame provenance leave rates unverified without shifting clocks", () => {
  const items = [
    rx(1, 0, 0, [1, 2]),
    rx(3, 105, 2, [3]),
    source({ ...event(4, 250), kind: "control", payload: {} }),
  ];
  const model = busLoad(
    { target, items, endEventSeq: "5", frames: [frame] },
    100,
  );
  expect(model?.unresolved).toBe(1);
  expect(model?.hasCodec).toBe(false);
  expect(model?.buckets).toMatchObject([
    { gap: true, receivedBytes: 2n, complete: false, framesComplete: false },
    { gap: true, receivedBytes: 1n, complete: false, framesComplete: false },
    { gap: false, receivedBytes: 0n, complete: false, framesComplete: false },
  ]);
  expect(
    busLoad(
      {
        target,
        frames: [],
        items: [
          items[0]!,
          source({
            ...event(2, 10),
            instanceEpoch: "4",
            kind: "control",
            payload: {},
          }),
        ],
      },
      100,
    ),
  ).toBeUndefined();
});

test("a page continuation cannot present earlier frames as a zero rate", () => {
  const resumed = {
    target,
    items: [
      rx(1, 0, 0, [1, 2, 3]),
      rx(2, 50, 3, [4, 5, 6]),
      rx(3, 100, 6, [7, 8, 9]),
      rx(4, 250, 9, [10, 11, 12]),
      source({ ...event(5, 300), kind: "control", payload: {} }),
    ],
    endEventSeq: "6",
    frames: [
      {
        hex: "08 09",
        byteStart: "7",
        byteEnd: "9",
        eventStart: "3",
        eventEnd: "4",
      },
      {
        hex: "0A 0B 0C",
        byteStart: "9",
        byteEnd: "12",
        eventStart: "4",
        eventEnd: "5",
      },
    ],
  };
  expect(
    busLoad({ ...resumed, frameStart: { eventSeq: "3", byteStart: "7" } }, 100)
      ?.buckets,
  ).toMatchObject([
    { offsetMs: 0n, receivedBytes: 6n, complete: true, framesComplete: false },
    {
      offsetMs: 100n,
      receivedBytes: 3n,
      complete: true,
      framesComplete: false,
    },
    {
      offsetMs: 200n,
      receivedBytes: 3n,
      parsedFrames: 1,
      framesComplete: true,
    },
    { offsetMs: 300n, complete: false, framesComplete: false },
  ]);
  const fromEvent = busLoad(
    { ...resumed, frameStart: { eventSeq: "3", byteStart: "6" } },
    100,
  );
  expect(fromEvent?.buckets[1]?.framesComplete).toBe(true);
  const sameTick = busLoad(
    {
      ...resumed,
      items: resumed.items.map((item, index) =>
        index === 1 ? rx(2, 100, 3, [4, 5, 6]) : item,
      ),
      frameStart: { eventSeq: "3", byteStart: "6" },
    },
    100,
  );
  expect(sameTick?.buckets[1]?.framesComplete).toBe(false);
});

test("bus load keeps the last 60 intervals without allocating for the entire history", () => {
  const model = busLoad(
    {
      target,
      frames: [],
      endEventSeq: "3",
      items: [
        rx(1, 0, 0, [1]),
        source({ ...event(2, 100000), kind: "control", payload: {} }),
      ],
    },
    10,
  );
  expect(model?.buckets).toHaveLength(60);
  expect(model?.buckets[0]).toMatchObject({
    offsetMs: 99410n,
    receivedBytes: 0n,
    complete: true,
  });
  expect(model?.buckets.at(-1)).toMatchObject({
    offsetMs: 100000n,
    complete: false,
  });
});
