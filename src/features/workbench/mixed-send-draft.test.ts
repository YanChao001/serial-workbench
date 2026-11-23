import { expect, it } from "vitest";
import { prepareTextEncoding } from "@/lib/text-encoding";
import { convertMixedSendDraft } from "./mixed-send-draft";

it("parses adjacent escapes, double-quoted text, and two-digit byte tokens", () => {
  const source = String.raw`41 42 "AB" \r\n0xFF\h(4F 4B)<CR><LF>`;
  expect(convertMixedSendDraft(source, "utf-8")).toBe(
    "41 42 41 42 0D 0A FF 4F 4B 0D 0A",
  );
});

it("preserves quoted text and encodes its quote and backslash escapes", async () => {
  await prepareTextEncoding("utf-16le");
  expect(convertMixedSendDraft(String.raw`"中\"\\" \x00`, "utf-16le")).toBe(
    "2D 4E 22 00 5C 00 00",
  );
  expect(convertMixedSendDraft('"0xAB <LF>"', "utf-8")).toBe(
    "30 78 41 42 20 3C 4C 46 3E",
  );
});

it.each([
  ["41 4", 3, 4],
  ["41 4142", 3, 7],
  ["41 0x123", 3, 8],
  ['41 "AB', 3, 6],
  [String.raw`41 "\xG0"`, 4, 8],
])("locates invalid mixed input %s", (source, start, end) => {
  expect(() => convertMixedSendDraft(source, "utf-8")).toThrow(
    expect.objectContaining({ kind: "syntax", start, end }),
  );
});
