import type { RawEvent, StreamItem, Target } from "@serial-workbench/contracts";
import { expect, test } from "vitest";
import { compileProtocolFields } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import {
  chartValue,
  fieldChartFrames,
  fieldChartSelection,
  fieldChartSpans,
  locateChartSelection,
  sharesChartSegment,
} from "./field-chart-model";
import { retainedChartSelection } from "./stream-chart-selection";
import { receivedFramingRange, selectedFramingRange } from "./framing-model";

const target: Target = {
  kind: "session",
  id: "session",
  hostId: "host",
  sessionId: "session",
  sessionEpoch: "3",
};
const origin = 9007199254740993n;
const codec = compileProtocolFields({
  version: "1",
  byteLength: 3,
  fields: [
    {
      id: "value",
      kind: "integer",
      byteOffset: 0,
      width: 2,
      order: "big",
      scale: "0.25",
      unit: "V",
    },
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

function source(
  seq: number,
  offset: number,
  bytes: number[],
  revision = "1",
): StreamItem {
  const event: RawEvent = {
    hostId: target.hostId,
    sessionId: target.id,
    sessionEpoch: "3",
    instanceEpoch: "2",
    eventSeq: String(seq),
    configurationRevision: revision,
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
    kind: "rx",
    payload: {
      bytesBase64: btoa(String.fromCharCode(...bytes)),
      byteStart: String(origin + BigInt(offset)),
      byteEnd: String(origin + BigInt(offset + bytes.length)),
    },
  };
  return { kind: "source", event };
}

const frames = [
  {
    hex: "01 02 03",
    eventStart: "11",
    eventEnd: "13",
    byteStart: String(origin + 1n),
    byteEnd: String(origin + 4n),
  },
  {
    hex: "00 08 08",
    eventStart: "12",
    eventEnd: "14",
    byteStart: String(origin + 4n),
    byteEnd: String(origin + 7n),
  },
  {
    hex: "00 02 00",
    eventStart: "14",
    eventEnd: "15",
    byteStart: String(origin + 7n),
    byteEnd: String(origin + 10n),
  },
  {
    hex: "00 03 03",
    eventStart: "15",
    eventEnd: "16",
    byteStart: String(origin + 10n),
    byteEnd: String(origin + 13n),
  },
];

test("field cursor keeps exact Raw byte pieces for a reading split across RX events", () => {
  const items = [
    source(11, 0, [255, 1]),
    source(12, 2, [2, 3, 0]),
    source(13, 5, [8, 8]),
  ];
  const [first, second] = fieldChartFrames(
    {
      target,
      frames: frames.slice(0, 2),
      items,
    },
    codec,
  );
  expect(chartValue(first!, "value")).toBe(64.5);
  expect(fieldChartSpans(first!, first!.readings![0]!)).toEqual([
    {
      event: "11",
      start: "9007199254740994",
      end: "9007199254740995",
      hex: "01",
    },
    {
      event: "12",
      start: "9007199254740995",
      end: "9007199254740996",
      hex: "02",
    },
  ]);
  expect(chartValue(second!, "value")).toBe(2);
  expect(sharesChartSegment(first!, second!)).toBe(true);
  const linked = fieldChartSelection(first!, first!.readings![0]!);
  expect(linked?.hex).toBe("01 02");
  expect(retainedChartSelection(items, linked!.range)).toEqual({
    first: 0,
    last: 1,
    hex: "01 02",
  });
  expect(retainedChartSelection(items.slice(1), linked!.range)).toBeUndefined();
  expect(locateChartSelection([first!, second!], linked!)).toEqual({
    entry: first,
    field: "value",
  });
  expect(
    locateChartSelection([first!, second!], { ...linked!, hex: "01 FF" }),
  ).toBeUndefined();
  const history = [
    ...items,
    ...Array.from({ length: 1050 }, (_, i) => source(14 + i, 7 + i, [0])),
  ];
  expect(
    Number(receivedFramingRange(history, target).startEventSeq),
  ).toBeGreaterThan(12);
  expect(selectedFramingRange(history, target, linked)).toEqual({
    startEventSeq: "11",
    endEventSeq: "14",
  });
});

test("missing source, mismatched bytes and a failed checksum leave separate evidence gaps", () => {
  const [missing, mismatch, badChecksum, resumed] = fieldChartFrames(
    {
      target,
      frames,
      items: [
        source(12, 2, [2, 3, 5]),
        source(13, 5, [8, 8]),
        source(14, 7, [0, 2, 0]),
        source(15, 10, [0, 3, 3], "2"),
      ],
    },
    codec,
  );
  expect([missing?.source, mismatch?.source]).toEqual([undefined, undefined]);
  expect(badChecksum?.source).toBeDefined();
  expect(
    [missing, mismatch, badChecksum, resumed].map((entry) =>
      chartValue(entry!, "value"),
    ),
  ).toEqual([undefined, undefined, undefined, 0.75]);
  expect(sharesChartSegment(badChecksum!, resumed!)).toBe(false);
});
