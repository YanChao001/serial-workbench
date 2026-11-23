import { describe, expect, it } from "vitest";
import {
  defaultHexFormat,
  formatStreamHex,
  hexByteBoundary,
  hexCharacter,
  HEX_GROUPS,
  type HexFormat,
} from "./stream-hex";

const bytes = "41 5A 20 7E 00 FF 0A 61 32 42 7F 21";
const address = "9007199254741018";
const adorned: HexFormat = {
  ...defaultHexFormat,
  columns: "8",
  group: "2",
  lowerCase: true,
  offsets: true,
  ascii: true,
};

describe("formatted receive HEX", () => {
  it("keeps byte order and supports all group widths with a partial last group", () => {
    const expected = [
      "41 5A 20 7E 00 FF 0A 61\n32 42 7F 21",
      "415A 207E 00FF 0A61\n3242 7F21",
      "415A207E 00FF0A61\n32427F21",
      "415A207E00FF0A61\n32427F21",
    ];
    expect(
      HEX_GROUPS.map((group) =>
        formatStreamHex(bytes, address, {
          ...defaultHexFormat,
          columns: "8",
          group,
        }),
      ),
    ).toEqual(expected);
  });

  it("aligns ASCII and increments full 64-bit offsets across lines", () => {
    const [first, second] = formatStreamHex(bytes, address, adorned).split(
      "\n",
    );
    expect(first).toBe("002000000000001a  415a 207e 00ff 0a61  AZ ~...a");
    expect(second).toBe(
      "0020000000000022  3242 7f21" + " ".repeat(12) + "2B.!",
    );
    expect(first?.indexOf("AZ")).toBe(second?.indexOf("2B"));
  });

  it("preserves a selection endpoint on the outside edge of a record", () => {
    const start = { byte: 0, ascii: false };
    const end = { byte: 12, ascii: false };
    expect(hexCharacter(start, 12, adorned, true)).toBe(
      hexCharacter(start, 12, adorned, false),
    );
    expect(hexCharacter(end, 12, adorned, true)).toBe(
      hexCharacter(end, 12, adorned, false),
    );
  });

  it("round-trips byte ranges through regrouping, decorations and short rows", () => {
    const wide: HexFormat = { ...adorned, columns: "32", group: "8" };
    for (const format of [defaultHexFormat, adorned, wide]) {
      for (const ascii of [false, format.ascii]) {
        for (let byte = 0; byte < 12; byte++) {
          const start = { byte, ascii };
          const end = { byte: byte + 1, ascii };
          expect(
            hexByteBoundary(
              hexCharacter(start, 12, format, false),
              12,
              format,
              false,
            ),
          ).toEqual(start);
          expect(
            hexByteBoundary(
              hexCharacter(end, 12, format, true),
              12,
              format,
              true,
            ),
          ).toEqual(end);
        }
      }
    }
  });
});
