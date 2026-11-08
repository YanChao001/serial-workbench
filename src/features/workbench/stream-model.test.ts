import { describe, expect, it } from "vitest";
import type { StreamItem } from "@serial-workbench/contracts";
import { findStreamMatches } from "./stream-model";

export function rx(
  bytesBase64: string,
  start: string,
  end: string,
  seq = "1",
): StreamItem {
  return {
    kind: "source",
    event: {
      hostId: "host",
      instanceEpoch: "1",
      sessionId: "session",
      sessionEpoch: "1",
      eventSeq: seq,
      configurationRevision: "1",
      time: {
        clockId: "clock",
        sourceMonoNs: "1",
        receivedWallTime: "2026-11-08T00:00:00Z",
        precision: {
          source: "host_read",
          resolutionNs: "1",
          syncMethod: "none",
        },
      },
      kind: "rx",
      payload: { bytesBase64, byteStart: start, byteEnd: end },
    },
  };
}

describe("stream byte search", () => {
  it("finds split UTF-8 at original byte offsets beyond JS safe integers", () => {
    expect(
      findStreamMatches(
        [
          rx("QeS4", "9007199254740993", "9007199254740996"),
          rx("rUI=", "9007199254740996", "9007199254740998", "2"),
        ],
        "中B",
        "text",
      ),
    ).toEqual([
      { offset: "9007199254740994", end: "9007199254740998", itemIndex: 0 },
    ]);
  });
  it("finds HEX bytes without changing original offsets", () => {
    expect(
      findStreamMatches([rx("AEFC/w==", "24", "28")], "41 42 ff", "hex"),
    ).toEqual([{ offset: "25", end: "28", itemIndex: 0 }]);
  });
  it("does not manufacture a match across a reader gap", () => {
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
      findStreamMatches(
        [rx("QQ==", "0", "1"), gap, rx("Qg==", "1", "2", "3")],
        "AB",
        "text",
      ),
    ).toEqual([]);
  });
});
