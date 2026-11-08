import type { LineEnding } from "@serial-workbench/contracts";
import { describe, expect, it } from "vitest";
import { formatHex } from "./hex";
import { encodeSend } from "./transforms";

describe("encodeSend", () => {
  const endings: { ending: LineEnding; bytes: number[]; preview: string }[] = [
    { ending: { kind: "none" }, bytes: [], preview: "41" },
    { ending: { kind: "cr" }, bytes: [13], preview: "41 0D" },
    { ending: { kind: "lf" }, bytes: [10], preview: "41 0A" },
    { ending: { kind: "crlf" }, bytes: [13, 10], preview: "41 0D 0A" },
    {
      ending: { kind: "custom", bytesBase64: "AP8NCg==" },
      bytes: [0, 255, 13, 10],
      preview: "41 00 FF 0D 0A",
    },
  ];

  it.each(endings)(
    "uses the same final bytes for $ending.kind preview and send",
    ({ ending, bytes, preview }) => {
      expect(encodeSend("A", "text", ending)).toEqual(
        Uint8Array.of(65, ...bytes),
      );
      expect(formatHex(encodeSend("A", "text", ending))).toBe(preview);
      expect(encodeSend("41", "hex", ending)).toEqual(
        Uint8Array.of(65, ...bytes),
      );
    },
  );

  it("encodes UTF-8 text and appends the ending without normalizing existing newlines", () => {
    expect(encodeSend("中\n", "text", { kind: "crlf" })).toEqual(
      Uint8Array.of(0xe4, 0xb8, 0xad, 10, 13, 10),
    );
  });

  it("appends an ending to empty input and accepts empty custom bytes", () => {
    expect(encodeSend("", "hex", { kind: "cr" })).toEqual(Uint8Array.of(13));
    expect(encodeSend("", "text", { kind: "custom", bytesBase64: "" })).toEqual(
      new Uint8Array(),
    );
  });

  it.each(["0", "A B", "00,FF", "0x41"])(
    "rejects invalid HEX before producing send bytes: %j",
    (input) => {
      expect(() => encodeSend(input, "hex", { kind: "crlf" })).toThrow();
    },
  );

  it.each([
    "!",
    "AA",
    "AA=",
    "AA===",
    " AB==",
    "AB==",
    "AAB=",
    "AA-_",
    "AA==\n",
  ])("rejects noncanonical custom Base64: %j", (bytesBase64) => {
    expect(() =>
      encodeSend("A", "text", { kind: "custom", bytesBase64 }),
    ).toThrow();
  });
});
