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
