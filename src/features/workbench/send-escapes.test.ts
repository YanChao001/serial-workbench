import { expect, it } from "vitest";
import { prepareTextEncoding } from "@/lib/text-encoding";
import { expandSendEscapes } from "./send-escapes";

it("expands the supported short forms, raw hex and line-feed tokens", () => {
  expect(
    expandSendEscapes(
      "AT\\r\\n\\t\\0\\xFF,0x41<CR><LF>\\h(4F 4B)\\\\",
      "utf-8",
    ),
  ).toBe("41 54 0D 0A 09 00 FF 2C 41 0D 0A 4F 4B 5C");
  expect(expandSendEscapes("AT0x41", "utf-8")).toBe("41 54 30 78 34 31");
});

it("encodes literal pieces with the selected encoding and retains raw escape bytes", async () => {
  await prepareTextEncoding("utf-16le");
  expect(expandSendEscapes("中<CR>字", "utf-16le")).toBe("2D 4E 0D 57 5B");
});

it.each(["\\", "\\xF", "\\h()", "\\h(ABC)", "\\h(41", "0xA", "0x420"])(
  "rejects the incomplete or ambiguous escape %s",
  (input) => {
    expect(() => expandSendEscapes(input, "utf-8")).toThrow(
      expect.objectContaining({ kind: "syntax", start: 0 }),
    );
  },
);

it("checks the converted size against the shared draft bound", () => {
  expect(expandSendEscapes("A".repeat(21_845), "utf-8")).toHaveLength(65_534);
  expect(() => expandSendEscapes("A".repeat(21_846), "utf-8")).toThrow(
    expect.objectContaining({ kind: "limit" }),
  );
});
