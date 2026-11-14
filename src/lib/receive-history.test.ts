import { expect, it, vi } from "vitest";
import type { StreamItem } from "@serial-workbench/contracts";
import { txItem } from "@/features/workbench/test-fixtures";
import {
  DEFAULT_RECEIVE_HISTORY,
  ReceiveHistoryBuffer,
  parseReceiveHistory,
  receiveHistoryLimits,
  setReceiveHistoryLimits,
  subscribeReceiveHistoryLimits,
  historyAfter,
  historyPosition,
  historyTrimmedAfter,
} from "./receive-history";

function record(
  sequence: number,
  byteLength = 1,
  continuous = false,
): StreamItem {
  const source = txItem("tx_intent");
  if (source.kind !== "source") throw new Error("Expected source fixture");
  return {
    kind: "source",
    event: {
      ...source.event,
      kind: "rx",
      eventSeq: String(sequence),
      time: {
        ...source.event.time,
        sourceMonoNs: String(sequence * (continuous ? 1 : 200_000_000)),
      },
      payload: {
        bytesBase64: btoa("x".repeat(byteLength)),
        byteStart: String((sequence - 1) * byteLength),
        byteEnd: String(sequence * byteLength),
      },
    },
  };
}
const sequences = (items: readonly StreamItem[]) =>
  items.map((item) => (item.kind === "source" ? item.event.eventSeq : "gap"));

it("keeps a continuous hardware burst below the configured data limit even when reads are fragmented", () => {
  const history = new ReceiveHistoryBuffer(DEFAULT_RECEIVE_HISTORY);
  history.append(
    Array.from({ length: 5000 }, (_, index) => record(index + 1, 16, true)),
  );
  const retained = history
    .items()
    .reduce(
      (bytes, item) =>
        bytes +
        (item.kind === "source" && item.event.kind === "rx"
          ? atob(item.event.payload.bytesBase64).length
          : 0),
      0,
    );
  expect(retained).toBe(80000);
  expect(history.trimmed).toBe(false);
});

it("retains the newest complete records and applies lower limits without new traffic", () => {
  const history = new ReceiveHistoryBuffer({
    ...DEFAULT_RECEIVE_HISTORY,
    maxRecords: 3,
  });
  history.append(Array.from({ length: 6 }, (_, index) => record(index + 1)));
  expect(sequences(history.items())).toEqual(["4", "5", "6"]);
  expect(history.trimmed).toBe(true);
  history.setLimits({ ...DEFAULT_RECEIVE_HISTORY, maxRecords: 5 });
  history.append([record(7), record(8)]);
  expect(sequences(history.items())).toEqual(["4", "5", "6", "7", "8"]);
  expect(history.setLimits({ ...DEFAULT_RECEIVE_HISTORY, maxRecords: 2 })).toBe(
    true,
  );
  expect(sequences(history.items())).toEqual(["7", "8"]);
});

it("enforces the byte budget independently of the record limit", () => {
  const history = new ReceiveHistoryBuffer({
    ...DEFAULT_RECEIVE_HISTORY,
    maxRecords: 20000,
  });
  history.append(
    Array.from({ length: 100 }, (_, index) => record(index + 1, 16384)),
  );
  const items = history.items();
  const bytes = items.reduce(
    (total, item) =>
      total +
      (item.kind === "source" && item.event.kind === "rx"
        ? atob(item.event.payload.bytesBase64).length
        : 0),
    0,
  );
  expect(bytes).toBeLessThanOrEqual(DEFAULT_RECEIVE_HISTORY.maxBytes);
  expect(items.length).toBeGreaterThan(0);
  expect(items.length).toBeLessThan(100);
  expect(sequences(items)).toEqual(
    Array.from({ length: items.length }, (_, index) =>
      String(101 - items.length + index),
    ),
  );
});

it("retains exactly the data-byte budget across continuous segments and trims only the oldest prefix", () => {
  const history = new ReceiveHistoryBuffer(DEFAULT_RECEIVE_HISTORY);
  history.append(
    Array.from({ length: 80 }, (_, index) => record(index + 1, 16384, true)),
  );
  expect(history.items()).toHaveLength(16);
  expect(
    history
      .items()
      .reduce(
        (sum, item) =>
          sum +
          (item.kind === "source" && item.event.kind === "rx"
            ? atob(item.event.payload.bytesBase64).length
            : 0),
        0,
      ),
  ).toBe(1024 * 1024);
  const first = history.items()[0]!;
  expect(
    first.kind === "source" &&
      first.event.kind === "rx" &&
      first.event.payload.byteStart,
  ).toBe("262144");
  expect(history.trimmed).toBe(true);
  expect(history.setLimits(DEFAULT_RECEIVE_HISTORY)).toBe(false);
});

it("does not count the final TX receipt twice or restore cleared bytes after compaction and eviction", () => {
  const history = new ReceiveHistoryBuffer({
    ...DEFAULT_RECEIVE_HISTORY,
    maxRecords: 2,
  });
  history.append([txItem("tx_intent"), record(1, 16, true)]);
  const position = historyPosition(history.items());
  history.append([txItem("tx"), record(2, 16, true)]);
  expect(history.items()).toHaveLength(2);
  expect(history.trimmed).toBe(false);
  const afterClear = historyAfter(history.items(), position);
  expect(afterClear).toHaveLength(1);
  expect(
    afterClear[0]?.kind === "source" &&
      afterClear[0].event.kind === "rx" &&
      afterClear[0].event.payload.byteStart,
  ).toBe("16");
  history.append([record(3, 16), record(4, 16)]);
  expect(historyTrimmedAfter(history.removed, position)).toBe(true);
  const cleared = historyPosition(history.items(), history.removed);
  expect(historyTrimmedAfter(history.removed, cleared)).toBe(false);
  expect(historyAfter(history.items(), cleared)).toHaveLength(0);
});

it("preserves explicit message boundaries and the send intent timestamp in display projections", () => {
  const history = new ReceiveHistoryBuffer(DEFAULT_RECEIVE_HISTORY);
  const fragments = [
    record(1, 16, true),
    record(2, 16, true),
    record(3, 16, true),
  ].map((item, index): StreamItem => {
    if (item.kind !== "source" || item.event.kind !== "rx")
      throw new Error("Missing RX");
    return {
      ...item,
      event: {
        ...item.event,
        payload: {
          ...item.event.payload,
          message: {
            messageId: index < 2 ? "first" : "second",
            messageType: "frame",
            messageLength: "32",
            fragmentOffset: index === 1 ? "16" : "0",
          },
        },
      },
    };
  });
  history.append(fragments);
  expect(history.items()).toHaveLength(2);
  const first = history.items()[0]!;
  expect(
    first.kind === "source" &&
      first.event.kind === "rx" &&
      first.event.payload.message?.fragmentOffset,
  ).toBe("0");
  const intent = txItem("tx_intent");
  const final = txItem("tx");
  if (intent.kind !== "source" || final.kind !== "source")
    throw new Error("Missing TX");
  const sentAt = { ...intent.event.time, sourceMonoNs: "1" };
  history.append([{ ...intent, event: { ...intent.event, time: sentAt } }]);
  history.append([
    {
      ...final,
      event: {
        ...final.event,
        time: { ...final.event.time, sourceMonoNs: "100" },
      },
    },
  ]);
  expect(history.items().at(-1)?.displayTime).toEqual(sentAt);
});

it("publishes only valid changed limits and releases its subscriptions", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeReceiveHistoryLimits(listener);
  try {
    setReceiveHistoryLimits({ maxRecords: 5000, maxBytes: 4 * 1024 * 1024 });
    expect(receiveHistoryLimits().maxRecords).toBe(5000);
    setReceiveHistoryLimits({ maxRecords: 5000, maxBytes: 4 * 1024 * 1024 });
    expect(listener).toHaveBeenCalledOnce();
    expect(() =>
      parseReceiveHistory({ maxRecords: 0, maxBytes: 1024 * 1024 }),
    ).toThrow();
    expect(() =>
      parseReceiveHistory({ maxRecords: 1, maxBytes: 17 * 1024 * 1024 }),
    ).toThrow();
    expect(receiveHistoryLimits().maxRecords).toBe(5000);
  } finally {
    unsubscribe();
    setReceiveHistoryLimits(DEFAULT_RECEIVE_HISTORY);
  }
  expect(listener).toHaveBeenCalledOnce();
});
