import type { StreamItem } from "@serial-workbench/contracts";
import { projectStreamItems } from "./stream-model";
import {
  findAnsiMatches,
  type AnsiSearchRequest,
  type AnsiSearchResult,
} from "./ansi-search";
import {
  prepareStreamSearchEncoding,
  searchStream,
  sourceInSearchDirection,
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
  for (const { item, itemIndex } of projectStreamItems(items)) {
    if (!sourceInSearchDirection(item, options.direction)) continue;
    source.push(item);
    indices.push(itemIndex);
  }
  const originalPositions = (
    result: StreamSearchResult,
  ): StreamSearchResult => ({
    ...result,
    matches: result.matches.map((match) => ({
      ...match,
      itemIndex: indices[match.itemIndex]!,
      ...(match.span
        ? {
            span: {
              ...match.span,
              lastItemIndex: indices[match.span.lastItemIndex]!,
            },
          }
        : {}),
    })),
  });
  // 在结构化克隆前限制字节量；正则和解码工作留在可终止的 Worker。
  if (!withinSearchBudget(source, options.direction))
    return Promise.resolve({ matches: [], error: "limit" });
  if (import.meta.env.MODE === "test" && typeof Worker === "undefined")
    return (
      mode === "text" ? prepareStreamSearchEncoding(options) : Promise.resolve()
    ).then(() => {
      signal.throwIfAborted();
      return originalPositions(searchStream(source, query, mode, options));
    });
  return runSearchWorker<StreamSearchResult>(
    { items: source, query, mode, options },
    signal,
  ).then(originalPositions);
}

export function requestAnsiSearch(
  request: AnsiSearchRequest,
  signal: AbortSignal,
): Promise<AnsiSearchResult> {
  signal.throwIfAborted();
  if (import.meta.env.MODE === "test" && typeof Worker === "undefined")
    return Promise.resolve(findAnsiMatches(request));
  return runSearchWorker<AnsiSearchResult>(request, signal);
}

function runSearchWorker<Result>(
  request:
    | AnsiSearchRequest
    | {
        items: readonly StreamItem[];
        query: string;
        mode: "text" | "hex";
        options: StreamSearchOptions;
      },
  signal: AbortSignal,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./stream-search.worker.ts", import.meta.url),
      { type: "module" },
    );
    const finish = () => {
      clearTimeout(timeout);
      worker.onmessage = null;
      worker.onerror = null;
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
    worker.onmessage = (event: MessageEvent<Result>) => {
      finish();
      resolve(event.data);
    };
    worker.onerror = () => {
      finish();
      reject(new Error("SEARCH_FAILED"));
    };
    try {
      worker.postMessage(request);
    } catch (error) {
      finish();
      reject(error);
    }
  });
}
