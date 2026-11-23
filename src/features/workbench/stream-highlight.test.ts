import { expect, it } from "vitest";
import {
  HIGHLIGHT_BATCH_UNITS,
  findStreamHighlights,
  type StreamHighlightRule,
} from "./stream-highlight";

function rule(
  id: string,
  pattern: string,
  mode: StreamHighlightRule["mode"] = "keyword",
): StreamHighlightRule {
  return { id, enabled: true, mode, pattern, bold: true };
}

it("gives an earlier overlapping rule precedence and preserves Unicode text positions", () => {
  const result = findStreamHighlights({
    mode: "highlight",
    texts: ["😀ERR+42"],
    rules: [
      rule("keyword", "ERR+"),
      rule("expression", "ERR[+]\\d+", "regex"),
      rule("zero", "^", "regex"),
    ],
  });
  expect(result).toEqual({
    rows: [
      [
        { start: 2, end: 6, rule: 0 },
        { start: 6, end: 8, rule: 1 },
      ],
    ],
    invalid: [],
  });
});

it("isolates invalid and disabled rules and bounds the number of output ranges", () => {
  const result = findStreamHighlights({
    mode: "highlight",
    texts: ["ab".repeat(300), "missing"],
    rules: [
      rule("invalid", "[", "regex"),
      { ...rule("disabled", "missing"), enabled: false },
      rule("valid", "b"),
    ],
  });
  expect(result.invalid).toEqual(["invalid"]);
  expect(result.rows[0]).toHaveLength(256);
  expect(result.rows[0]?.[0]).toEqual({ start: 1, end: 2, rule: 2 });
  expect(result.rows[1]).toEqual([]);
  expect(result.limited).toBe(true);
});

it("rejects a text batch over the worker allocation budget", () => {
  expect(
    findStreamHighlights({
      mode: "highlight",
      texts: ["x".repeat(HIGHLIGHT_BATCH_UNITS + 1)],
      rules: [rule("keyword", "x")],
    }),
  ).toEqual({ rows: [], invalid: [], limited: true });
});
