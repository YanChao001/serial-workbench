import { describe, expect, it } from "vitest";
import type { StreamItem } from "@serial-workbench/contracts";
import { findNextStreamMatch, projectStreamItems } from "./stream-model";
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
  it("preserves overlapping matches and the first item's index across read blocks", () => {
    const items = [
      rx(btoa("AA"), "10", "12"),
      rx(btoa("AAA"), "12", "15", "2"),
    ];
    let previous: string | undefined;
    const matches = Array.from({ length: 4 }, () => {
      const next = findNextStreamMatch(items, "AAA", "text", previous);
      previous = next?.offset;
      return next;
    });
    expect(matches).toEqual([
      { offset: "10", end: "13", itemIndex: 0 },
      { offset: "11", end: "14", itemIndex: 0 },
      { offset: "12", end: "15", itemIndex: 1 },
      { offset: "10", end: "13", itemIndex: 0 },
    ]);
  });
  it("falls back to a matching prefix without losing a later complete match", () => {
    const items = [
      rx(btoa("ABABABAC"), "0", "8"),
      rx(btoa("ABABAC"), "8", "14", "2"),
    ];
    expect(findNextStreamMatch(items, "ABABAC", "text")).toEqual({
      offset: "2",
      end: "8",
      itemIndex: 0,
    });
    expect(findNextStreamMatch(items, "ABABAC", "text", "2")).toEqual({
      offset: "8",
      end: "14",
      itemIndex: 1,
    });
    expect(findNextStreamMatch(items, "ABABAC", "text", "8")).toEqual({
      offset: "2",
      end: "8",
      itemIndex: 0,
    });
  });
  it.each(["hostId", "instanceEpoch", "sessionId", "sessionEpoch"] as const)(
    "does not join a matching prefix across a different %s",
    (field) => {
      const next = rx("Qg==", "1", "2", "2");
      if (next.kind !== "source") throw new Error("Expected source");
      expect(
        findNextStreamMatch(
          [
            rx("QQ==", "0", "1"),
            { ...next, event: { ...next.event, [field]: "2" } },
          ],
          "AB",
          "text",
        ),
      ).toBeNull();
    },
  );
  it.each(["configuration_boundary", "lifecycle"] as const)(
    "does not join a matching prefix across a %s event",
    (kind) => {
      const before = rx("QQ==", "0", "1");
      if (before.kind !== "source") throw new Error("Expected source");
      const boundary: StreamItem =
        kind === "lifecycle"
          ? {
              kind: "source",
              event: { ...before.event, kind, payload: { state: "closed" } },
            }
          : {
              kind: "source",
              event: {
                ...before.event,
                kind,
                payload: {
                  revision: "2",
                  certainty: "confirmed",
                  receiptRef: {
                    hostId: "host",
                    kind: "operation",
                    id: "configuration",
                  },
                },
              },
            };
      expect(
        findNextStreamMatch(
          [before, boundary, rx("Qg==", "1", "2", "3")],
          "AB",
          "text",
        ),
      ).toBeNull();
    },
  );
  it("searches a long repeated prefix spanning multiple read blocks", () => {
    const items = Array.from({ length: 4 }, (_, index) =>
      rx(
        btoa("A".repeat(16384)),
        String(index * 16384),
        String((index + 1) * 16384),
        String(index + 1),
      ),
    );
    expect(
      findNextStreamMatch(items, "A".repeat(8191) + "B", "text"),
    ).toBeNull();
    expect(findNextStreamMatch(items, "A", "text", "65534")).toEqual({
      offset: "65535",
      end: "65536",
      itemIndex: 3,
    });
    expect(findNextStreamMatch(items, "A", "text", "65535")).toEqual({
      offset: "0",
      end: "1",
      itemIndex: 0,
    });
  });
  it("finds split UTF-8 at original byte offsets beyond JS safe integers", () => {
    expect(
      findNextStreamMatch(
        [
          rx("QeS4", "9007199254740993", "9007199254740996"),
          rx("rUI=", "9007199254740996", "9007199254740998", "2"),
        ],
        "中B",
        "text",
      ),
    ).toEqual({
      offset: "9007199254740994",
      end: "9007199254740998",
      itemIndex: 0,
    });
  });
  it("finds HEX bytes without changing original offsets", () => {
    expect(
      findNextStreamMatch([rx("AEFC/w==", "24", "28")], "41 42 ff", "hex"),
    ).toEqual({ offset: "25", end: "28", itemIndex: 0 });
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
      findNextStreamMatch(
        [rx("QQ==", "0", "1"), gap, rx("Qg==", "1", "2", "3")],
        "AB",
        "text",
      ),
    ).toBeNull();
  });
});
