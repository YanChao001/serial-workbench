import { expect, it } from "vitest";
import type { StreamItem } from "@serial-workbench/contracts";
import { txItem } from "./test-fixtures";
import { searchStream } from "./stream-search";
import { encodeText, prepareTextEncoding } from "@/lib/text-encoding";

it("finds GBK and UTF-16 text across receive chunks with original byte offsets", async () => {
  await prepareTextEncoding("gbk");
  for (const encoding of ["gbk", "utf-16le", "utf-16be"] as const) {
    const bytes = encodeText("A你好B", encoding);
    const result = searchStream(
      [rx(bytes.slice(0, 2)), rx(bytes.slice(2), "2")],
      "你好",
      "text",
      { ...options, encoding },
    );
    const start = encoding === "gbk" ? "1" : "2";
    expect(result.matches).toEqual([
      {
        offset: start,
        end: String(Number(start) + 4),
        itemIndex: encoding === "gbk" ? 0 : 1,
      },
    ]);
  }
});

const options = { caseSensitive: false, wholeWord: false, regex: false };
function rx(bytes: Uint8Array, start = "0"): StreamItem {
  const template = txItem("tx");
  if (template.kind !== "source") throw new Error("Expected source fixture");
  return {
    kind: "source",
    event: {
      ...template.event,
      kind: "rx",
      payload: {
        bytesBase64: btoa(String.fromCharCode(...bytes)),
        byteStart: start,
        byteEnd: (BigInt(start) + BigInt(bytes.length)).toString(),
      },
    },
  };
}
const text = (value: string, start?: string) =>
  rx(new TextEncoder().encode(value), start);

it("finds case-insensitive words and excludes Unicode word prefixes and suffixes", () => {
  const items = [text("Cat cats 中cat cat中 CAT")];
  expect(searchStream(items, "cat", "text", options).matches).toHaveLength(5);
  expect(
    searchStream(items, "cat", "text", {
      ...options,
      wholeWord: true,
    }).matches.map((m) => m.offset),
  ).toEqual(["0", "23"]);
  expect(
    searchStream(items, "Cat", "text", { ...options, caseSensitive: true })
      .matches,
  ).toHaveLength(1);
});
it("maps regex UTF-16 indexes to exact UTF-8 offsets across read chunks and beyond safe integers", () => {
  const bytes = new TextEncoder().encode("A😀中B");
  const start = 9007199254740993n;
  const items = [
    rx(bytes.slice(0, 3), String(start)),
    rx(bytes.slice(3), String(start + 3n)),
  ];
  expect(
    searchStream(items, "😀.B", "text", { ...options, regex: true }).matches,
  ).toEqual([
    { offset: String(start + 1n), end: String(start + 9n), itemIndex: 0 },
  ]);
});
it("never matches across a gap or a configuration change", () => {
  const a = text("A"),
    b = text("B", "1");
  const gap: StreamItem = {
    kind: "reader_gap",
    gap: {
      hostId: "host",
      instanceEpoch: "1",
      sessionId: "session",
      sessionEpoch: "1",
      reason: "reader_overflow",
      missingEventRange: { start: "2", end: "3" },
    },
  };
  expect(
    searchStream([a, gap, b], "A.B|AB", "text", { ...options, regex: true })
      .matches,
  ).toEqual([]);
  if (b.kind !== "source") throw new Error("Expected source");
  b.event.configurationRevision = "2";
  expect(searchStream([a, b], "AB", "text", options).matches).toEqual([]);
});
it("handles zero-width patterns, invalid patterns and non-UTF-8 HEX search", () => {
  expect(
    searchStream(
      [rx(new Uint8Array([239, 187, 191, 65]))],
      "A",
      "text",
      options,
    ).matches,
  ).toEqual([{ offset: "3", end: "4", itemIndex: 0 }]);
  expect(
    searchStream([text("😀")], "(?=.)", "text", { ...options, regex: true })
      .matches,
  ).toEqual([]);
  expect(
    searchStream([text("a")], "[", "text", { ...options, regex: true }).error,
  ).toBe("syntax");
  const items = [rx(new Uint8Array([255, 65, 0]))];
  expect(searchStream(items, "ff 41", "hex", options).matches).toEqual([
    { offset: "0", end: "2", itemIndex: 0 },
  ]);
  expect(searchStream(items, "A", "text", options).error).toBe("encoding");
});
