import type { RawEvent, StreamItem, Target } from "@serial-workbench/contracts";
import { expect, test } from "vitest";
import { compileProtocolFields } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import { fieldChartCsv } from "./field-chart-csv";
import { fieldChartMdf4 } from "./field-chart-mdf4";
import {
  chartValue,
  fieldChartFrames,
  fieldChartPairs,
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

test("chart MDF4 keeps proved invalid readings and rejects a mixed capture configuration", () => {
  const inspection = {
    target,
    frames,
    items: [
      source(11, 0, [255, 1]),
      source(12, 2, [2, 3, 0]),
      source(13, 5, [8, 8]),
      source(14, 7, [0, 2, 0]),
      source(15, 10, [0, 3, 3], "2"),
    ],
  };
  const entries = fieldChartFrames(inspection, codec);
  const selected = [entries[0]!.readings![0]!];
  expect(fieldChartMdf4(inspection, entries, 0, selected)).toEqual({
    status: "time",
  });
  const result = fieldChartMdf4(inspection, entries.slice(0, 3), 0, selected);
  if (result.status !== "ready")
    throw new Error("Expected one capture configuration");
  expect(result.snapshot.samples).toEqual([
    {
      elapsedNs: "0",
      values: [
        "64.5",
        "1",
        "11",
        "13",
        "9007199254740994",
        "9007199254740997",
        "0",
      ],
    },
    {
      elapsedNs: "1000",
      values: [
        "2",
        "2",
        "12",
        "14",
        "9007199254740997",
        "9007199254741000",
        "0",
      ],
    },
    {
      elapsedNs: "2000",
      values: [
        null,
        "3",
        "14",
        "15",
        "9007199254741000",
        "9007199254741003",
        "0",
      ],
    },
  ]);
});

test("chart CSV preserves exact byte offsets and separates invalid values from evidence", () => {
  const inspection = {
    target,
    frames,
    items: [
      source(11, 0, [255, 1]),
      source(12, 2, [2, 3, 0]),
      source(13, 5, [8, 8]),
      source(14, 7, [0, 2, 0]),
    ],
    recordOrdinals: new Map([
      ["11", "39"],
      ["12", "40"],
    ]),
  };
  const entries = fieldChartFrames(inspection, codec);
  const primary = {
    ...entries[0]!.readings![0]!,
    unit: '=HYPERLINK("sample")',
  };
  const rows = fieldChartCsv({
    inspection,
    entries,
    start: 0,
    mode: "trace",
    primary,
  })
    .trimEnd()
    .split("\r\n");
  expect(rows).toHaveLength(5);
  expect(rows[1]).toContain(
    '1,trace,start,,true,host,2,session,3,1,test-clock,11,13,9007199254740994,9007199254740997,value,64.5,"\'=HYPERLINK(""sample"")",258,',
  );
  expect(rows[1]).toContain(
    '""event"":""12"",""start"":""9007199254740995"",""end"":""9007199254740996"",""hex"":""02"",""record"":""40""',
  );
  expect(rows[3]).toContain(
    '3,trace,continuous,0,false,host,2,session,3,1,test-clock,14,15,9007199254741000,9007199254741003,value,,"\'=HYPERLINK(""sample"")",2,',
  );
  expect(rows[4]).toMatch(/^4,trace,gap,,false,{11}value,,/u);
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

test("paired fields use matching frames and leave a break at invalid intermediate points", () => {
  const pairs = fieldChartFrames(
    {
      target,
      frames,
      items: [
        source(11, 0, [255, 1]),
        source(12, 2, [2, 3, 0]),
        source(13, 5, [8, 8]),
        source(14, 7, [0, 2, 0]),
        source(15, 10, [0, 3, 3]),
      ],
    },
    compileProtocolFields({
      version: "1",
      byteLength: 3,
      fields: [
        { id: "x", kind: "integer", byteOffset: 0, width: 1, order: "big" },
        { id: "y", kind: "integer", byteOffset: 1, width: 1, order: "big" },
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
    }),
  );
  expect(fieldChartPairs(pairs, 0, "x", "y")).toEqual([
    [
      { index: 0, x: 1, y: 2 },
      { index: 1, x: 0, y: 8 },
    ],
    [{ index: 3, x: 0, y: 3 }],
  ]);
  expect(fieldChartPairs(pairs, 2, "x", "y")).toEqual([
    [{ index: 3, x: 0, y: 3 }],
  ]);
});
