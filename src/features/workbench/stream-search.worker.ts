/// <reference lib="webworker" />
import { searchStream } from "./stream-search";
import type { StreamItem } from "@serial-workbench/contracts";
import type { StreamSearchOptions } from "./stream-search";
import { prepareTextEncoding } from "@/lib/text-encoding";
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (
  event: MessageEvent<{
    items: StreamItem[];
    query: string;
    mode: "text" | "hex";
    options: StreamSearchOptions;
  }>,
) => {
  const { items, query, mode, options } = event.data;
  if (mode === "text") await prepareTextEncoding(options.encoding ?? "utf-8");
  scope.postMessage(searchStream(items, query, mode, options));
};
