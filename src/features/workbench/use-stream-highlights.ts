import { useEffect, useRef, useState } from "react";
import {
  HIGHLIGHT_BATCH_ROWS,
  HIGHLIGHT_BATCH_UNITS,
  type HighlightRange,
  type StreamHighlightRule,
} from "./stream-highlight";
import { requestStreamHighlights } from "./stream-search-client";

type HighlightState = {
  rules: readonly StreamHighlightRule[];
  ranges: ReadonlyMap<string, HighlightRange[]>;
  invalid: readonly string[];
  limited?: true;
  failed?: "timeout" | "worker";
};

type Work = {
  controller: AbortController;
  pending: boolean;
  timer?: ReturnType<typeof setTimeout>;
  texts: readonly string[];
  result?: HighlightState;
};

export function useStreamHighlights(
  rules: readonly StreamHighlightRule[],
  texts: readonly string[],
  enabled: boolean,
): HighlightState | undefined {
  const work = useRef<Work | undefined>(undefined);
  const [result, setResult] = useState<HighlightState>();
  useEffect(() => {
    if (!enabled || !rules.some((rule) => rule.enabled && rule.pattern)) return;
    const current: Work = {
      controller: new AbortController(),
      pending: false,
      texts: [],
    };
    work.current = current;
    return () => {
      current.controller.abort();
      clearTimeout(current.timer);
      work.current = undefined;
    };
  }, [enabled, rules]);

  useEffect(() => {
    const current = work.current;
    if (!current) return;
    current.texts = texts;
    function schedule(active: Work) {
      if (active.pending || active.result?.failed) return;
      active.pending = true;
      active.timer = setTimeout(() => void run(active), 80);
    }

    async function run(active: Work) {
      const { signal } = active.controller;
      let units = 0;
      const batch = new Set<string>();
      // New data has priority. Exact strings can reuse ranges as rows move after eviction.
      for (const text of active.texts) {
        if (!text || active.result?.ranges.has(text) || batch.has(text))
          continue;
        if (
          batch.size === HIGHLIGHT_BATCH_ROWS ||
          units + text.length > HIGHLIGHT_BATCH_UNITS
        )
          break;
        batch.add(text);
        units += text.length;
      }
      if (!batch.size && active.result) {
        active.pending = false;
        return;
      }

      const input = [...batch];
      try {
        const next = await requestStreamHighlights(
          { mode: "highlight", texts: input, rules },
          signal,
        );
        if (signal.aborted) return;
        const retained = new Set(active.texts);
        const ranges = new Map<string, HighlightRange[]>();
        for (const [text, highlights] of active.result?.ranges ?? []) {
          if (retained.has(text)) ranges.set(text, highlights);
        }
        for (const [index, text] of input.entries()) {
          if (retained.has(text)) ranges.set(text, next.rows[index] ?? []);
        }
        active.result = {
          rules,
          ranges,
          invalid: next.invalid,
          limited: next.limited || active.result?.limited,
        };
      } catch (error) {
        if (signal.aborted) return;
        active.result = {
          rules,
          ranges: active.result?.ranges ?? new Map(),
          invalid: active.result?.invalid ?? [],
          limited: active.result?.limited,
          failed:
            error instanceof Error && error.message === "SEARCH_TIMEOUT"
              ? "timeout"
              : "worker",
        };
      }
      active.pending = false;
      setResult(active.result);
      if (batch.size) schedule(active);
    }
    schedule(current);
  }, [enabled, rules, texts]);

  return enabled && result?.rules === rules ? result : undefined;
}
