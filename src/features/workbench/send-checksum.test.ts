import { expect, it } from "vitest";
import {
  appendSendChecksum,
  DEFAULT_SEND_CHECKSUM,
  type ChecksumAlgorithm,
} from "./send-checksum";

it.each<{
  algorithm: ChecksumAlgorithm;
  big: number[];
  little: number[];
}>([
  { algorithm: "sum", big: [0xdd], little: [0xdd] },
  { algorithm: "xor", big: [0x31], little: [0x31] },
  { algorithm: "modbus", big: [0x4b, 0x37], little: [0x37, 0x4b] },
  { algorithm: "ccitt", big: [0x29, 0xb1], little: [0xb1, 0x29] },
  {
    algorithm: "crc32",
    big: [0xcb, 0xf4, 0x39, 0x26],
    little: [0x26, 0x39, 0xf4, 0xcb],
  },
])(
  "matches the 123456789 check value for $algorithm in both byte orders",
  ({ algorithm, big, little }) => {
    const body = new TextEncoder().encode("123456789");
    for (const [order, expected] of [
      ["big", big],
      ["little", little],
    ] as const) {
      const result = appendSendChecksum(body, body.length, {
        ...DEFAULT_SEND_CHECKSUM,
        algorithm,
        order,
      });
      expect(result?.checksum).toEqual(Uint8Array.from(expected));
      expect(result?.bytes).toEqual(Uint8Array.of(...body, ...expected));
    }
    expect(new TextDecoder().decode(body)).toBe("123456789");
  },
);

it.each([
  { start: "-1", end: "2" },
  { start: "1.0", end: "2" },
  { start: "0", end: "0" },
  { start: "2", end: "1" },
  { start: "2", end: "5" },
  { start: "9999999999999999", end: "" },
  { start: "0x1", end: "" },
])("rejects invalid byte ranges $start through $end", ({ start, end }) => {
  expect(
    appendSendChecksum(Uint8Array.of(0x41, 0x42, 0x0d, 0x0a), 2, {
      ...DEFAULT_SEND_CHECKSUM,
      algorithm: "sum",
      start,
      end,
    }),
  ).toBeNull();
});

it("extends the selectable range to the ending without appending it again", () => {
  const payload = Uint8Array.of(0x41, 0x42, 0x0d, 0x0a);
  const options = {
    ...DEFAULT_SEND_CHECKSUM,
    algorithm: "xor",
    start: "1",
  } as const;
  const body = appendSendChecksum(payload, 2, options);
  const withEnding = appendSendChecksum(payload, 2, {
    ...options,
    includeEnding: true,
  });
  expect(body?.bytes).toEqual(Uint8Array.of(...payload, 0x42));
  expect(withEnding?.bytes).toEqual(Uint8Array.of(...payload, 0x45));
  expect(appendSendChecksum(new Uint8Array(), 0, options)).toBeNull();
});
