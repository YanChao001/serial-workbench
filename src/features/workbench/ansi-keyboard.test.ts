import { afterEach, expect, it, vi } from "vitest";
import type { Operation } from "@serial-workbench/contracts";
import { prepareTextEncoding } from "@/lib/text-encoding";
import { createAnsiKeyboardWriter, encodeAnsiKey } from "./ansi-keyboard";
import { operation, txItem } from "./test-fixtures";

function receipt(outcome: "accepted" | "partial"): Operation {
  const item = txItem("tx", "0", outcome);
  if (item.kind !== "source" || item.event.kind !== "tx")
    throw new Error("Missing TX fixture");
  return { ...operation(), result: { kind: "tx", value: item.event.payload } };
}

function deferredOperation() {
  let resolve!: (operation: Operation) => void;
  const promise = new Promise<Operation>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

it("keeps control codes native while character keys use the selected encoding", async () => {
  await prepareTextEncoding("utf-16le");
  const key = (name: string, altKey = false, ctrlKey = false) => ({
    key: name,
    altKey,
    ctrlKey,
  });
  expect(encodeAnsiKey("A", key("A"), "utf-16le")).toEqual(
    Uint8Array.of(65, 0),
  );
  expect(encodeAnsiKey("\x01", key("a", false, true), "utf-16le")).toEqual(
    Uint8Array.of(1),
  );
  expect(encodeAnsiKey("\x1bOA", key("ArrowUp"), "utf-16le")).toEqual(
    Uint8Array.of(27, 79, 65),
  );
  expect(encodeAnsiKey("\x1ba", key("a", true), "utf-16le")).toEqual(
    Uint8Array.of(27, 97, 0),
  );
});

it("serializes batches and drops unsubmitted keys when the owner leaves", async () => {
  vi.useFakeTimers();
  const terminal = deferredOperation();
  const send = vi.fn(() => terminal.promise);
  const stop = vi.fn();
  const writer = createAnsiKeyboardWriter(send, stop);
  writer.enqueue(Uint8Array.of(0x41));
  writer.enqueue(Uint8Array.of(0x42));
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(
    Uint8Array.of(0x41, 0x42),
    expect.any(AbortSignal),
  );
  writer.enqueue(Uint8Array.of(0x43));
  writer.cancel();
  terminal.resolve(receipt("accepted"));
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
});

it("stops after a partial result and never resubmits the accumulated keys", async () => {
  vi.useFakeTimers();
  const terminal = deferredOperation();
  const send = vi.fn(() => terminal.promise);
  const stop = vi.fn();
  const writer = createAnsiKeyboardWriter(send, stop);
  writer.enqueue(Uint8Array.of(0x41));
  await vi.runAllTimersAsync();
  writer.enqueue(Uint8Array.of(0x42));
  terminal.resolve(receipt("partial"));
  await vi.runAllTimersAsync();
  expect(stop).toHaveBeenCalledWith("operation");
  expect(send).toHaveBeenCalledOnce();
});

it("replaces a pending window size while an earlier send is awaiting its receipt", async () => {
  vi.useFakeTimers();
  const first = deferredOperation();
  const send = vi.fn(() => Promise.resolve(receipt("accepted")));
  send.mockReturnValueOnce(first.promise);
  const writer = createAnsiKeyboardWriter(send, vi.fn());
  writer.enqueue(Uint8Array.of(0x41));
  await vi.runAllTimersAsync();
  writer.reportWindowSize(24, 80);
  await vi.runAllTimersAsync();
  writer.reportWindowSize(30, 110);
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledOnce();
  first.resolve(receipt("accepted"));
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenNthCalledWith(
    2,
    new TextEncoder().encode("\x1b[8;30;110t"),
    expect.any(AbortSignal),
  );
  writer.reportWindowSize(30, 110);
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(2);
});

it("clears unsubmitted window size reports while the keyboard remains usable", async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => receipt("accepted"));
  const writer = createAnsiKeyboardWriter(send, vi.fn());
  writer.reportWindowSize(0, 80);
  writer.reportWindowSize(24, Number.POSITIVE_INFINITY);
  writer.reportWindowSize(24, 65_536);
  await vi.runAllTimersAsync();
  expect(send).not.toHaveBeenCalled();
  writer.reportWindowSize(24, 80);
  await vi.advanceTimersByTimeAsync(100);
  writer.reportWindowSize(25, 82);
  await vi.advanceTimersByTimeAsync(100);
  expect(send).not.toHaveBeenCalled();
  writer.clearWindowSize();
  writer.enqueue(Uint8Array.of(0x41));
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledExactlyOnceWith(
    Uint8Array.of(0x41),
    expect.any(AbortSignal),
  );
});
