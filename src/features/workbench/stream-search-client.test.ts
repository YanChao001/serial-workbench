import { afterEach, expect, it, vi } from "vitest";
import { requestStreamSearch } from "./stream-search-client";
import type { StreamSearchResult } from "./stream-search";
import type { StreamItem } from "@serial-workbench/contracts";
import { txItem } from "./test-fixtures";
const options = { caseSensitive: false, wholeWord: false, regex: true };
class SearchWorker {
  static instances: SearchWorker[] = [];
  onmessage?: (event: MessageEvent<StreamSearchResult>) => void;
  onerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    SearchWorker.instances.push(this);
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  SearchWorker.instances = [];
});
it("copies only receive data and continuity boundaries, then restores original display indexes", async () => {
  vi.stubGlobal("Worker", SearchWorker);
  const tx = txItem("tx");
  if (tx.kind !== "source") throw new Error("Expected source fixture");
  const rx: StreamItem = {
    kind: "source",
    event: {
      ...tx.event,
      kind: "rx",
      payload: { bytesBase64: "QQ==", byteStart: "0", byteEnd: "1" },
    },
  };
  const pending = requestStreamSearch(
    [tx, rx],
    "A",
    "text",
    options,
    new AbortController().signal,
  );
  const worker = SearchWorker.instances[0]!;
  expect(worker.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ items: [rx] }),
  );
  worker.onmessage?.(
    new MessageEvent("message", {
      data: { matches: [{ offset: "0", end: "1", itemIndex: 0 }] },
    }),
  );
  expect(await pending).toEqual({
    matches: [{ offset: "0", end: "1", itemIndex: 1 }],
  });
});
it("terminates an unresponsive regex worker at the budget rather than leaving a background task", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", SearchWorker);
  const result = requestStreamSearch(
    [],
    "(a+)+$",
    "text",
    options,
    new AbortController().signal,
  );
  const rejected = expect(result).rejects.toThrow("SEARCH_TIMEOUT");
  await vi.advanceTimersByTimeAsync(500);
  await rejected;
  expect(SearchWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
});
it("cancels obsolete searches and clears the timer after a successful response", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", SearchWorker);
  const controller = new AbortController();
  const old = requestStreamSearch(
    [],
    "old",
    "text",
    options,
    controller.signal,
  );
  const cancelled = expect(old).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await cancelled;
  expect(SearchWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  const current = requestStreamSearch(
    [],
    "new",
    "text",
    options,
    new AbortController().signal,
  );
  const worker = SearchWorker.instances[1]!;
  worker.onmessage?.(new MessageEvent("message", { data: { matches: [] } }));
  expect(await current).toEqual({ matches: [] });
  await vi.advanceTimersByTimeAsync(1000);
  expect(worker.terminate).toHaveBeenCalledOnce();
});
