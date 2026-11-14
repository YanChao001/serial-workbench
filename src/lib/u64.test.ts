import { expect, it, vi } from "vitest";
import { parseU64, U64_MAX } from "./u64";

it.each([
  ["0", 0n],
  ["42", 42n],
  ["18446744073709551615", U64_MAX],
  ["18446744073709551616", undefined],
  ["", undefined],
  ["00", undefined],
  ["01", undefined],
  ["-1", undefined],
  ["+1", undefined],
  [" 1", undefined],
  ["1\n", undefined],
  ["1\r\n", undefined],
  ["1\u2028", undefined],
  ["1\u2029", undefined],
  ["1.0", undefined],
  ["1e3", undefined],
  ["１", undefined],
  [1, undefined],
  [null, undefined],
])("parses canonical bounded U64 input %s", (input, expected) => {
  expect(parseU64(input)).toBe(expected);
});

it("rejects oversized form input before allocating a BigInt", () => {
  const convert = vi.spyOn(globalThis, "BigInt");
  try {
    expect(parseU64("9".repeat(100000))).toBeUndefined();
    expect(convert).not.toHaveBeenCalled();
  } finally {
    convert.mockRestore();
  }
});
