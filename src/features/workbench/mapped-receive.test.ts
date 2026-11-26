import type { MessageFragment, StreamItem } from "@serial-workbench/contracts";
import { expect, it } from "vitest";
import { bytesToBase64 } from "@/lib/base64";
import type { CharacterRemapRules } from "./character-remap";
import { projectMappedReceive } from "./mapped-receive";
import { txItem } from "./test-fixtures";

const absolute = 9_007_199_254_741_100n;
const rules: CharacterRemapRules = {
  newline: "lf",
  backspace: "apply",
  letterCase: "lower",
  replacements: [],
};

function rx(
  sequence: number,
  offset: number,
  bytes: string | Uint8Array,
  message?: MessageFragment,
): StreamItem {
  const origin = txItem("tx");
  if (origin.kind !== "source") throw new Error("Missing source event fixture");
  const data =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const start = absolute + BigInt(offset);
  return {
    kind: "source",
    event: {
      ...origin.event,
      kind: "rx",
      eventSeq: String(sequence),
      payload: {
        bytesBase64: bytesToBase64(data),
        byteStart: String(start),
        byteEnd: String(start + BigInt(data.length)),
        ...(message ? { message } : {}),
      },
    },
  };
}

function message(
  messageId: string,
  fragmentOffset: string,
  messageLength: string,
  messageType = "text",
): MessageFragment {
  return { messageId, fragmentOffset, messageLength, messageType };
}

it("combines contiguous UTF-8, newline and backspace fragments without crossing a separate message", () => {
  const input = [
    rx(1, 0, Uint8Array.of(0xc3), message("a", "0", "5")),
    rx(2, 1, Uint8Array.of(0x89, 0x58, 0x08, 0x0d), message("a", "1", "5")),
    rx(3, 5, "\nQ", message("b", "0", "2")),
    rx(4, 7, "A\bB", message("c", "0", "3", "binary")),
    rx(5, 10, "Z\bA"),
    rx(6, 15, "\bC"),
  ];
  expect(projectMappedReceive(input, "utf-8", rules)).toMatchObject({
    limited: false,
    rows: [
      {
        start: String(absolute),
        end: String(absolute + 5n),
        firstItem: 0,
        firstEvent: "1",
        lastEvent: "2",
        result: { ok: true, text: "é\n" },
      },
      { firstEvent: "3", lastEvent: "3", result: { ok: true, text: "\nq" } },
      { firstEvent: "5", lastEvent: "5", result: { ok: true, text: "a" } },
      { firstEvent: "6", lastEvent: "6", result: { ok: true, text: "c" } },
    ],
  });
});

it("does not discard terminal codec errors for a complete message or flush an open fragment", () => {
  const input = [
    rx(1, 0, "A", message("one", "0", "1")),
    rx(2, 1, "B", message("two", "0", "2")),
  ];
  expect(projectMappedReceive(input, "utf-16le", rules).rows).toMatchObject([
    { result: { ok: true, text: "\ufffd" } },
    { result: { ok: true, text: "" } },
  ]);
});

it("bounds the source projection and preserves high-offset raw locations when expansion exceeds the display limit", () => {
  const length = 65_537;
  const input = [rx(1, 0, "Z".repeat(length))];
  const projection = projectMappedReceive(input, "utf-8", {
    ...rules,
    replacements: [{ source: "Z", replacement: "x".repeat(32) }],
  });
  expect(projection).toMatchObject({
    limited: true,
    rows: [
      {
        firstItem: 0,
        start: String(absolute + 1n),
        end: String(absolute + BigInt(length)),
        result: { ok: false, code: "output" },
      },
    ],
  });
});

it("keeps UTF-16 code units aligned when the recent window starts at an odd byte", () => {
  const input = new Uint8Array(65_537);
  for (let index = 0; index < input.length; index += 2) input[index] = 65;
  expect(
    projectMappedReceive([rx(1, 0, input)], "utf-16le", rules),
  ).toMatchObject({
    limited: true,
    rows: [
      {
        start: String(absolute + 2n),
        end: String(absolute + BigInt(input.length)),
        result: { ok: true, text: "a".repeat(32_767) },
      },
    ],
  });
});
