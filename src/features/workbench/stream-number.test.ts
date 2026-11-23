import { describe, expect, it } from "vitest";
import { parseHex } from "@serial-workbench/host-client";
import type { StreamHexSelection } from "./stream-hex-selection";
import { interpretStreamNumber, streamNumberSample } from "./stream-number";

function selection(start: bigint, end: bigint): StreamHexSelection {
  return {
    start: { source: "first", offset: start, ascii: false },
    end: { source: "last", offset: end, ascii: true },
    backwards: false,
  };
}

describe("stream number sample", () => {
  const start = 9_007_199_254_741_017n;
  const rows = [
    {
      hexSource: "first",
      hexLane: "rx",
      offset: start.toString(),
      byteEnd: (start + 3n).toString(),
      hex: "AB FF 01",
    },
    {
      hexSource: "last",
      hexLane: "rx",
      offset: (start + 3n).toString(),
      byteEnd: (start + 6n).toString(),
      hex: "51 00 EF",
    },
  ];

  it("takes a bounded raw range across records at full-width offsets", () => {
    const result = streamNumberSample(rows, selection(start + 1n, start + 5n));
    expect(result).toEqual({
      bytes: Uint8Array.of(255, 1, 81, 0),
      offset: start + 1n,
    });
  });

  it("rejects a gap, unrelated direction or session, stale endpoints, and more than 8 bytes", () => {
    const range = selection(start + 1n, start + 5n);
    expect(streamNumberSample([rows[0]!, {}, rows[1]!], range)).toBeUndefined();
    expect(
      streamNumberSample([rows[0]!, { ...rows[1]!, hexLane: "tx" }], range),
    ).toBeUndefined();
    expect(
      streamNumberSample(
        [rows[0]!, { ...rows[1]!, offset: (start + 4n).toString() }],
        range,
      ),
    ).toBeUndefined();
    expect(streamNumberSample(rows.slice(1), range)).toBeUndefined();
    expect(
      streamNumberSample(rows, selection(start, start + 9n)),
    ).toBeUndefined();
  });
});

describe("stream number interpretation", () => {
  it("preserves full width, sign, and radix representations beyond JS safe integers", () => {
    expect(
      interpretStreamNumber(parseHex("ff ff ff ff ff ff ff ff"), 8, false),
    ).toEqual({
      unsigned: "18446744073709551615",
      signed: "-1",
      hex: "FFFFFFFFFFFFFFFF",
      binary: "1".repeat(64),
      octal: "1" + "7".repeat(21),
      float: "NaN",
    });
    expect(interpretStreamNumber(parseHex("80 01"), 2, false).signed).toBe(
      "-32767",
    );
    expect(interpretStreamNumber(parseHex("80 01"), 2, true)).toMatchObject({
      unsigned: "384",
      signed: "384",
      hex: "0180",
      binary: "0000000110000000",
      octal: "000600",
    });
    expect(interpretStreamNumber(parseHex("80"), 1, false).signed).toBe("-128");
  });

  it("distinguishes signed zero, infinities, NaN and finite float values in both widths", () => {
    expect(interpretStreamNumber(parseHex("80 00 00 00"), 4, false).float).toBe(
      "-0",
    );
    expect(
      interpretStreamNumber(parseHex("80 00 00 00 00 00 00 00"), 8, false)
        .float,
    ).toBe("-0");
    expect(interpretStreamNumber(parseHex("7f 80 00 00"), 4, false).float).toBe(
      "Infinity",
    );
    expect(
      interpretStreamNumber(parseHex("00 00 00 00 00 00 f0 ff"), 8, true).float,
    ).toBe("-Infinity");
    expect(interpretStreamNumber(parseHex("00 00 80 3f"), 4, true).float).toBe(
      "1",
    );
    expect(
      interpretStreamNumber(parseHex("00 00 00 00 00 00 f0 3f"), 8, true).float,
    ).toBe("1");
    expect(interpretStreamNumber(parseHex("00 00 00 01"), 4, false).float).toBe(
      String(2 ** -149),
    );
  });
});
