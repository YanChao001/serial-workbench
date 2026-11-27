import { describe, expect, it } from "vitest";
import type { StreamItem } from "@serial-workbench/contracts";
import type { StreamHexSelection } from "./stream-hex-selection";
import {
  formatStreamCopy,
  readStreamCopySample,
  STREAM_COPY_LIMIT,
} from "./stream-copy";
import {
  formatStreamExport,
  streamExportPage,
  streamExportPageCount,
} from "./stream-selection-export";

const start = 9_007_199_254_741_031n;

const firstEvent = {
  hostId: "host",
  instanceEpoch: "1",
  sessionId: "session",
  sessionEpoch: "2",
  eventSeq: "1",
  configurationRevision: "1",
  kind: "rx",
  time: {
    clockId: "clock",
    sourceMonoNs: "1",
    sourceWallTime: "2026-11-24T01:00:01.001Z",
    receivedWallTime: "2026-11-24T01:00:02.002Z",
    precision: { source: "host_read", resolutionNs: "1", syncMethod: "none" },
  },
  payload: {
    byteStart: start.toString(),
    byteEnd: (start + 3n).toString(),
    bytesBase64: "/0Hk",
  },
} as const;

const source: StreamItem[] = [
  { kind: "source", event: firstEvent },
  {
    kind: "source",
    event: {
      ...firstEvent,
      eventSeq: "2",
      time: {
        ...firstEvent.time,
        sourceWallTime: undefined,
        sourceMonoNs: "2",
        receivedWallTime: "2026-11-24T01:00:03.003Z",
      },
      payload: {
        byteStart: (start + 3n).toString(),
        byteEnd: (start + 7n).toString(),
        bytesBase64: "uK1CAA==",
      },
    },
  },
];
const projected = source.map((item, itemIndex) => ({ item, itemIndex }));
const rows = [
  {
    hexSource: "first",
    hexLane: "rx",
    offset: start.toString(),
    byteEnd: (start + 7n).toString(),
    hex: "FF 41 E4 B8 AD 42 00",
    itemIndexes: [0, 1],
  },
];
const selection: StreamHexSelection = {
  start: { source: "first", offset: start + 1n, ascii: false },
  end: { source: "first", offset: start + 6n, ascii: true },
  backwards: false,
};

describe("copying selected stream bytes", () => {
  it("uses the same byte range in all formats and keeps joined rows' source times", () => {
    const selected = readStreamCopySample(rows, projected, selection);
    expect(selected?.bytes).toEqual(Uint8Array.of(65, 228, 184, 173, 66));
    if (!selected) throw new Error("Missing byte selection");
    const copy = (format: Parameters<typeof formatStreamCopy>[1]) =>
      formatStreamCopy(selected, format, "utf-8", "source");
    expect(copy("text")).toBe("A中B");
    expect(copy("hex")).toBe("41 E4 B8 AD 42");
    expect(copy("base64")).toBe("QeS4rUI=");
    expect(copy("c")).toBe(
      "const unsigned char data[] = {\n  0x41, 0xE4, 0xB8, 0xAD, 0x42,\n};",
    );
    expect(copy("python")).toBe('b"\\x41\\xE4\\xB8\\xAD\\x42"');
    expect(copy("timed")).toBe(
      "2026-11-24T01:00:01.001Z\tRX\t" +
        (start + 1n).toString() +
        '\t"A"\n' +
        "2026-11-24T01:00:03.003Z\tRX\t" +
        (start + 3n).toString() +
        '\t"中B"',
    );
    expect(formatStreamCopy(selected, "timed", "utf-8", "received")).toMatch(
      /^2026-11-24T01:00:02.002Z\t/,
    );
    expect(formatStreamCopy(selected, "text", "latin1", "source")).toBe(
      "A\u00E4\u00B8\u00ADB",
    );
  });

  it("locates the first selected byte in the second event of a joined row", () => {
    const selected = readStreamCopySample(rows, projected, {
      ...selection,
      start: { ...selection.start, offset: start + 3n },
    });
    expect(selected?.bytes).toEqual(Uint8Array.of(184, 173, 66));
    expect(selected?.anchor).toEqual({
      reference: 'SWB1 ["host","1","session","2","2","9007199254741034"]',
      event: "2",
      time: "2026-11-24T01:00:03.003Z",
    });
  });

  it("rejects unavailable source times and over-limit selections", () => {
    expect(
      readStreamCopySample(rows, projected.slice(0, 1), selection),
    ).toBeUndefined();
    expect(
      readStreamCopySample(rows, projected, {
        ...selection,
        end: {
          ...selection.end,
          offset: selection.start.offset + BigInt(STREAM_COPY_LIMIT + 1),
        },
      }),
    ).toBeUndefined();
  });
});

it("escapes printable selection bytes as text and keeps the same exact range in both export formats", () => {
  const bytes = Uint8Array.of(60, 62, 38, 34, 0, 255);
  const sample = { direction: "RX" as const, bytes, offset: start, parts: [] };
  const html = formatStreamExport(sample, "html", "light", 0);
  const svg = formatStreamExport(sample, "svg", "dark", 0);
  expect(html.name).toBe(`serial-selection-rx-${start}.html`);
  expect(svg.name).toBe(`serial-selection-rx-${start}-p1.svg`);
  for (const file of [html, svg]) {
    expect(file.content).toContain(`[${start}, ${start + 6n})`);
    expect(file.content).toContain("3C 3E 26 22 00 FF");
    expect(file.content).toContain("&lt;&gt;&amp;&quot;..");
    expect(file.content).not.toContain('<>&"');
  }
  expect(html.content).toContain("background:#ffffff");
  expect(svg.content).toContain('fill="#18181b"');
  const xml = new DOMParser().parseFromString(svg.content, "image/svg+xml");
  expect(xml.querySelector("parsererror")).toBeNull();
  expect(xml.querySelector("text:last-child")?.textContent).toContain(
    '|<>&"..|',
  );
});

it("splits an image at 1024 byte boundaries and preserves the short final page", () => {
  const bytes = new Uint8Array(1025).fill(0x41);
  bytes[1024] = 0x42;
  const sample = { direction: "TX" as const, bytes, offset: start, parts: [] };
  expect(streamExportPageCount(sample)).toBe(2);
  expect(streamExportPage(sample, 0).rows).toHaveLength(64);
  const final = streamExportPage(sample, 1);
  expect(final.rows).toHaveLength(1);
  expect(final.rows[0]).toEqual({
    offset: (start + 1024n).toString(),
    hex: "42",
    ascii: "B",
  });
  expect(final.range).toBe(`2/2 · [${start + 1024n}, ${start + 1025n})`);
  expect(() => streamExportPage(sample, 2)).toThrow(RangeError);
  const svg = formatStreamExport(sample, "svg", "light", 1);
  expect(svg.content).toContain('width="860" height="100"');
  const html = formatStreamExport(sample, "html", "light", 0);
  expect(html.content).toContain("break-before:page");
  expect(html.content).toContain(final.range);
  expect(html.content).toContain("|B|");
});
