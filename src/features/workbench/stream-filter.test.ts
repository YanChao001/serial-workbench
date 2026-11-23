import { expect, it } from "vitest";
import { filterStreamRows, streamMatchRanges } from "./stream-filter";
import type { StreamMatch } from "./stream-model";

const record = (kind: string, ...itemIndexes: number[]) => ({
  kind,
  itemIndexes,
});

it("filters both directions without treating interleaved TX as part of a cross-record RX match", () => {
  const rows = [
    record("rx", 0),
    record("tx", 1),
    record("rx", 2, 3),
    record("gap", 4),
    record("rx", 5),
  ];
  const matches: StreamMatch[] = [
    {
      offset: "0",
      end: "4",
      itemIndex: 0,
      span: { lastItemIndex: 2, direction: "rx" },
    },
  ];
  const ranges = streamMatchRanges(matches);
  expect(filterStreamRows(rows, "all", "only", ranges)).toEqual([
    rows[0],
    rows[2],
    rows[3],
  ]);
  expect(filterStreamRows(rows, "all", "hide", ranges)).toEqual([
    rows[1],
    rows[3],
    rows[4],
  ]);
  expect(filterStreamRows(rows, "tx", "all", ranges)).toEqual([
    rows[1],
    rows[3],
  ]);
  expect(filterStreamRows(rows, "all", "only", undefined)).toBe(rows);
  expect(filterStreamRows(rows, "all", "only", streamMatchRanges([]))).toEqual([
    rows[3],
  ]);
});
