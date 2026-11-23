import type { StreamDirection, StreamMatch } from "./stream-model";

export const SEARCH_DIRECTIONS = ["all", "rx", "tx"] as const;
export const MATCH_VISIBILITY = ["all", "only", "hide"] as const;
export type SearchDirection = (typeof SEARCH_DIRECTIONS)[number];
export type MatchVisibility = (typeof MATCH_VISIBILITY)[number];

type IndexRange = { first: number; last: number };

export function streamMatchRanges(matches: readonly StreamMatch[]) {
  const ranges: Record<StreamDirection, IndexRange[]> = { rx: [], tx: [] };
  for (const { itemIndex, span } of matches) {
    if (!span) continue;
    const lane = ranges[span.direction];
    const previous = lane.at(-1);
    if (previous && itemIndex <= previous.last + 1)
      previous.last = Math.max(previous.last, span.lastItemIndex);
    else lane.push({ first: itemIndex, last: span.lastItemIndex });
  }
  return ranges;
}

function includesIndex(ranges: readonly IndexRange[], index: number): boolean {
  let start = 0;
  let end = ranges.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    const range = ranges[middle]!;
    if (index < range.first) end = middle;
    else if (index > range.last) start = middle + 1;
    else return true;
  }
  return false;
}

export function filterStreamRows<
  T extends { kind: string; itemIndexes: readonly number[] },
>(
  rows: readonly T[],
  direction: SearchDirection,
  visibility: MatchVisibility,
  ranges: ReturnType<typeof streamMatchRanges> | undefined,
): readonly T[] {
  if (direction === "all" && (visibility === "all" || !ranges)) return rows;
  return rows.filter((row) => {
    if (row.kind !== "rx" && row.kind !== "tx") return true;
    const lane = row.kind;
    if (direction !== "all" && lane !== direction) return false;
    if (!ranges || visibility === "all") return true;
    const matched = row.itemIndexes.some((index) =>
      includesIndex(ranges[lane], index),
    );
    return visibility === "only" ? matched : !matched;
  });
}
