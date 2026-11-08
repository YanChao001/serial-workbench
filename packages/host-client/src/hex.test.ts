import { describe, expect, it } from "vitest";
import { formatHex, parseHex } from "./hex";

describe("HEX codec", () => {
  it("displays every byte as uppercase pairs separated by one space", () => {
    expect(formatHex(Uint8Array.of(0, 1, 15, 16, 127, 128, 255))).toBe(
      "00 01 0F 10 7F 80 FF",
    );
    expect(formatHex(new Uint8Array())).toBe("");
  });

  it.each(["00aF10ff", "00 aF 10 ff", " \t00\naF\v10\fFF\r ", "00aF 10ff"])(
    "parses continuous or ASCII whitespace separated bytes: %j",
    (input) => {
      expect(parseHex(input)).toEqual(Uint8Array.of(0, 175, 16, 255));
    },
  );

  it.each(["", " \t\r\n\v\f"])(
    "accepts an empty byte sequence: %j",
    (input) => {
      expect(parseHex(input)).toEqual(new Uint8Array());
    },
  );

  it.each([
    "0",
    "ABC",
    "A B",
    "00 A",
    "0x00",
    "00,FF",
    "-01",
    "GG",
    "00 FF",
    "00\u200bFF",
  ])("rejects invalid characters or partial bytes: %j", (input) => {
    expect(() => parseHex(input)).toThrow();
  });
});
