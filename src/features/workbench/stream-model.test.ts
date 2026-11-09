import { describe, expect, it } from "vitest";
import type { StreamItem } from "@serial-workbench/contracts";
import { findStreamMatches, projectStreamItems } from "./stream-model";
import { txItem } from "./test-fixtures";

describe("TX block projection", () => {
  it("keeps separate chunks of one file operation and updates each matching intent", () => {
    const firstIntent = txItem("tx_intent");
    const secondIntent = txItem("tx_intent", "5");
    const firstReceipt = txItem("tx", "0", "partial");
    const secondReceipt = txItem("tx", "5", "unknown");
    expect(
      projectStreamItems([
        firstIntent,
        secondIntent,
        firstReceipt,
        secondReceipt,
      ]),
    ).toEqual([
      { item: firstReceipt, itemIndex: 0 },
      { item: secondReceipt, itemIndex: 1 },
    ]);
  });
  it.each(["hostId", "instanceEpoch", "sessionId", "sessionEpoch"] as const)(
    "does not join equal operation IDs and spans across %s",
    (field) => {
      const receipt = txItem("tx");
      if (receipt.kind !== "source") throw new Error("Expected source");
      const different: StreamItem = {
        ...receipt,
        event: { ...receipt.event, [field]: "2" },
      };
      expect(projectStreamItems([txItem("tx_intent"), different])).toHaveLength(
        2,
      );
    },
  );
  it("shows a retained receipt when the intent was trimmed, and never invents a receipt", () => {
    const receipt = txItem("tx");
    const pending = txItem("tx_intent", "5");
    expect(projectStreamItems([receipt, pending])).toEqual([
      { item: receipt, itemIndex: 0 },
      { item: pending, itemIndex: 1 },
    ]);
  });
});

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
