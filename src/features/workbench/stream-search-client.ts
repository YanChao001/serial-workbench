import type { StreamItem } from "@serial-workbench/contracts";
import { prepareTextEncoding } from "@/lib/text-encoding";
import {
  searchStream,
  withinSearchBudget,
  type StreamSearchOptions,
  type StreamSearchResult,
} from "./stream-search";

export function requestStreamSearch(
  items: readonly StreamItem[],
  query: string,
  mode: "text" | "hex",
  options: StreamSearchOptions,
  signal: AbortSignal,
): Promise<StreamSearchResult> {
  signal.throwIfAborted();
  const source: StreamItem[] = [];
  const indices: number[] = [];
  for (const [index, item] of items.entries()) {
    if (
      item.kind !== "reader_gap" &&
      !["rx", "gap", "configuration_boundary", "lifecycle"].includes(
        item.event.kind,
      )
    )
      continue;
    source.push(item);
    indices.push(index);
  }
  const originalPositions = (
    result: StreamSearchResult,
  ): StreamSearchResult => ({
    ...result,
    matches: result.matches.map((match) => ({
      ...match,
      itemIndex: indices[match.itemIndex]!,
    })),
  });
  // 在结构化克隆前限制字节量；正则和解码工作留在可终止的 Worker。
  if (!withinSearchBudget(source))
    return Promise.resolve({ matches: [], error: "limit" });
  if (import.meta.env.MODE === "test" && typeof Worker === "undefined")
    return prepareTextEncoding(
      mode === "text" ? (options.encoding ?? "utf-8") : "utf-8",
    ).then(() => {
      signal.throwIfAborted();
      return originalPositions(searchStream(source, query, mode, options));
    });
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./stream-search.worker.ts", import.meta.url),
      { type: "module" },
    );
    const finish = () => {
      clearTimeout(timeout);
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(new DOMException("Search cancelled", "AbortError"));
    };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error("SEARCH_TIMEOUT"));
    }, 500);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<StreamSearchResult>) => {
      finish();
      resolve(originalPositions(event.data));
    };
    worker.onerror = () => {
      finish();
      reject(new Error("SEARCH_FAILED"));
    };
    try {
      worker.postMessage({ items: source, query, mode, options });
    } catch (error) {
      finish();
      reject(error);
    }
  });
}
