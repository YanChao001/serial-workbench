import { expect, it } from "vitest";
import type { HistoryStreamItem } from "@/lib/receive-history";
import { projectStreamItems } from "./stream-model";
import {
  findStreamLocation,
  numberStreamRows,
  streamLocationReference,
} from "./stream-location";
import { txItem } from "./test-fixtures";

const aboveSafe = 9_007_199_254_741_005n;

function rx(
  seq: string,
  offset: bigint,
  session = "session",
  displayRecord?: string,
): HistoryStreamItem {
  const fixture = txItem("tx");
  if (fixture.kind !== "source") throw new Error("Expected event fixture");
  return {
    kind: "source",
    displayRecord,
    event: {
      ...fixture.event,
      sessionId: session,
      eventSeq: seq,
      kind: "rx",
      payload: {
        byteStart: offset.toString(),
        byteEnd: (offset + 1n).toString(),
        bytesBase64: "QQ==",
      },
    },
  };
}

it("keeps line, display packet and full-width event sequence distinct", () => {
  const original = [
    rx("7", aboveSafe, "session", "one"),
    rx("8", aboveSafe + 1n, "session", "one"),
    rx(aboveSafe.toString(), aboveSafe + 2n),
  ];
  const rows = [
    { itemIndex: 0, itemIndexes: [0, 1] },
    { itemIndex: 2, itemIndexes: [2] },
  ];
  const numbers = numberStreamRows(
    rows,
    projectStreamItems(original),
    original,
  );
  const locatedEvent = findStreamLocation(
    numbers,
    "event",
    aboveSafe.toString(),
  );
  expect(locatedEvent).toMatchObject({
    kind: "found",
    row: { line: 2 },
    event: { packet: 2 },
  });
  expect(findStreamLocation(numbers, "event", "8")).toMatchObject({
    kind: "found",
    row: { line: 1 },
    event: { packet: 1 },
  });
  expect(findStreamLocation(numbers, "packet", "1")).toMatchObject({
    kind: "found",
    row: { line: 1 },
  });
  expect(findStreamLocation(numbers, "line", "2")).toMatchObject({
    kind: "found",
    row: { line: 2 },
  });
});

it("copies an exact event reference and rejects duplicate event numbers across sources and stale offsets", () => {
  const original = [rx("7", aboveSafe, "left"), rx("7", aboveSafe, "right")];
  const rows = [
    { itemIndex: 0, itemIndexes: [0] },
    { itemIndex: 1, itemIndexes: [1] },
  ];
  const numbers = numberStreamRows(
    rows,
    projectStreamItems(original),
    original,
  );
  const location = numbers.get(1)?.events[0];
  if (!location) throw new Error("Missing event");
  const token = streamLocationReference(location.locator);
  expect(findStreamLocation(numbers, "event", "7")).toEqual({
    kind: "ambiguous",
  });
  expect(findStreamLocation(numbers, "reference", token)).toMatchObject({
    kind: "found",
    row: { line: 2 },
  });
  const later = [original[0]!, rx("7", aboveSafe + 1n, "right")];
  const trimmed = numberStreamRows(rows, projectStreamItems(later), later);
  expect(findStreamLocation(trimmed, "reference", token)).toEqual({
    kind: "unavailable",
  });
  expect(
    findStreamLocation(numbers, "reference", 'SWB1 ["host","bad"]'),
  ).toEqual({ kind: "invalid" });
  expect(findStreamLocation(numbers, "event", "18446744073709551616")).toEqual({
    kind: "invalid",
  });
});

it("continues to locate the original transmit intent after its receipt updates the line", () => {
  const intent = txItem("tx_intent");
  const receipt = txItem("tx");
  const rows = [{ itemIndex: 0, itemIndexes: [0] }];
  const before = numberStreamRows(rows, projectStreamItems([intent]), [intent]);
  const event = before.get(0)?.events[0];
  if (!event) throw new Error("Missing intent");
  const reference = streamLocationReference(event.locator);
  const after = numberStreamRows(rows, projectStreamItems([intent, receipt]), [
    intent,
    receipt,
  ]);
  expect(findStreamLocation(after, "reference", reference)).toMatchObject({
    kind: "found",
    row: { line: 1 },
  });
  expect(findStreamLocation(after, "event", "2")).toMatchObject({
    kind: "found",
    row: { line: 1 },
    event: { packet: 1 },
  });
});
