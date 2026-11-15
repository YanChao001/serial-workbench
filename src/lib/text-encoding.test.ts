import { beforeAll, expect, it } from "vitest";
import type { LineEnding, TextEncoding } from "@serial-workbench/contracts";
import {
  createTextDecoder,
  createTextSendPreview,
  encodeText,
  encodeTextSend,
  prepareTextEncoding,
  receiveEncodingFor,
} from "./text-encoding";
import { convertSendDraft } from "@/features/workbench/send-draft-conversion";
import { detectTextEncoding } from "./encoding-detection";

beforeAll(async () => {
  await prepareTextEncoding("gbk");
});
it.each([
  ["utf-8", "你好", [0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]],
  ["gbk", "你好", [0xc4, 0xe3, 0xba, 0xc3]],
  ["big5", "中文", [0xa4, 0xa4, 0xa4, 0xe5]],
  ["shift-jis", "日本", [0x93, 0xfa, 0x96, 0x7b]],
  ["utf-16le", "你好", [0x60, 0x4f, 0x7d, 0x59]],
  ["utf-16be", "你好", [0x4f, 0x60, 0x59, 0x7d]],
  ["latin1", "é", [0xe9]],
  ["ascii", "ABC", [65, 66, 67]],
] satisfies [TextEncoding, string, number[]][])(
  "encodes %s to known wire bytes and decodes split chunks",
  (encoding, text, expected) => {
    const bytes = encodeText(text, encoding);
    expect([...bytes]).toEqual(expected);
    const preview = createTextSendPreview(
      text,
      "text",
      { kind: "none" },
      encoding,
    );
    expect(preview.byteLength).toBe(expected.length);
    const observed = preview.readBytes();
    expect([...observed]).toEqual(expected);
    observed.fill(0);
    expect([...preview.readBytes()]).toEqual(expected);
    const decoder = createTextDecoder(encoding, { fatal: true });
    expect(
      decoder.decode(bytes.slice(0, 1), { stream: true }) +
        decoder.decode(bytes.slice(1)),
    ).toBe(text);
    expect(convertSendDraft(text, "text", "hex", encoding)).toEqual({
      ok: true,
      draft: expected
        .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
        .join(" "),
    });
  },
);
it("captures custom suffixes before callers mutate them and isolates subsequent byte readers", () => {
  const ending: LineEnding = { kind: "custom", bytesBase64: "/wA=" };
  const preview = createTextSendPreview("A", "text", ending, "utf-8");
  ending.bytesBase64 = "AA==";
  expect(preview.byteLength).toBe(3);
  const observed = preview.readBytes();
  expect([...observed]).toEqual([65, 255, 0]);
  observed.fill(0);
  expect([...preview.readBytes()]).toEqual([65, 255, 0]);
  expect(Object.isFrozen(preview)).toBe(true);
});
it("rejects every isolated UTF-16 surrogate instead of silently sending replacement bytes", () => {
  for (let code = 0xd800; code <= 0xdfff; code++) {
    const text = `A${String.fromCharCode(code)}Z`;
    expect(() => encodeText(text, "utf-8")).toThrow("unrepresentable");
    expect(() =>
      createTextSendPreview(text, "text", { kind: "none" }, "utf-8"),
    ).toThrow("unrepresentable");
  }
});
it.each([
  ["first supplementary scalar", "\ud800\udc00"],
  ["last supplementary scalar", "\udbff\udfff"],
  ["adjacent pairs", "\ud800\udfff\udbff\udc00"],
  ["BMP boundaries", "\ud7ff\ue000"],
  ["BOM, NUL and replacement scalar", "\ufeff\u0000\ufffd"],
  ["mixed text", "A你好🙂Z"],
])("preserves exact UTF-8 for %s", (_name, text) => {
  const bytes = encodeText(text, "utf-8");
  expect(bytes).toEqual(new TextEncoder().encode(text));
  expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)).toBe(
    text,
  );
});
it("supports GB18030 supplementary characters while GBK rejects unrepresentable text", () => {
  const bytes = encodeText("中文😀", "gb18030");
  expect(createTextDecoder("gb18030", { fatal: true }).decode(bytes)).toBe(
    "中文😀",
  );
  expect(() => encodeText("中文😀", "gbk")).toThrow("unrepresentable");
  expect(convertSendDraft("中文😀", "text", "hex", "gbk")).toEqual({
    ok: false,
    code: "UNREPRESENTABLE",
  });
});
it("encodes textual line endings in the selected encoding and leaves HEX bodies and custom suffix bytes exact", () => {
  expect([
    ...encodeTextSend("A", "text", { kind: "crlf" }, "utf-16le"),
  ]).toEqual([65, 0, 13, 0, 10, 0]);
  expect([
    ...encodeTextSend(
      "A",
      "text",
      { kind: "custom", bytesBase64: "/wA=" },
      "utf-16le",
    ),
  ]).toEqual([65, 0, 255, 0]);
  expect([
    ...encodeTextSend("C4 E3", "hex", { kind: "none" }, "utf-16be"),
  ]).toEqual([196, 227]);
  expect(convertSendDraft("C4 E3", "hex", "text", "gbk")).toEqual({
    ok: true,
    draft: "你",
  });
  expect(convertSendDraft("C4", "hex", "text", "gbk")).toEqual({
    ok: false,
    code: "INVALID_ENCODING",
  });
});
it.each(["utf-16le", "utf-16be", "gbk"] satisfies TextEncoding[])(
  "preserves final %s wire bytes when switching between text and HEX with CRLF",
  (encoding) => {
    const conversion = convertSendDraft("你好", "text", "hex", encoding);
    if (!conversion.ok) throw new Error(conversion.code);
    expect(
      encodeTextSend(conversion.draft, "hex", { kind: "crlf" }, encoding),
    ).toEqual(encodeTextSend("你好", "text", { kind: "crlf" }, encoding));
  },
);
it("keeps Latin-1 C1 bytes distinct from Windows-1252 and rejects high bytes in strict ASCII", () => {
  expect(createTextDecoder("latin1").decode(new Uint8Array([0x80]))).toBe(
    "\u0080",
  );
  expect(() =>
    createTextDecoder("ascii", { fatal: true }).decode(new Uint8Array([0x80])),
  ).toThrow();
  expect(receiveEncodingFor(null, "gbk")).toBeNull();
  expect(receiveEncodingFor(undefined)).toBe("utf-8");
});
it("detects BOM, valid UTF-8, Chinese GB18030, and reports ASCII as still ambiguous", () => {
  expect(detectTextEncoding("\u00FF\u00FEA\0").encoding).toBe("utf-16le");
  expect(detectTextEncoding("AT\r\n").reason).toBe("pending");
  const utf8 = new TextEncoder().encode("中文测试");
  expect(detectTextEncoding(String.fromCharCode(...utf8)).encoding).toBe(
    "utf-8",
  );
  const chinese = encodeText(
    "这是串口工作台的中文编码识别测试，我们正在发送接收数据并检查设备连接状态。".repeat(
      5,
    ),
    "gbk",
  );
  expect(detectTextEncoding(String.fromCharCode(...chinese)).encoding).toBe(
    "gb18030",
  );
});
