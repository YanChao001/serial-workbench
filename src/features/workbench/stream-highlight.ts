import { compileStreamTextPattern } from "./stream-text-pattern";

export const MAX_HIGHLIGHT_RULES = 8;
export const MAX_HIGHLIGHT_PATTERN = 256;
export const HIGHLIGHT_BATCH_UNITS = 131_072;
export const HIGHLIGHT_BATCH_ROWS = 256;
const MAX_RANGES_PER_ROW = 256;

export type StreamHighlightRule = {
  id: string;
  enabled: boolean;
  mode: "keyword" | "regex";
  pattern: string;
  foreground?: string;
  background?: string;
  bold: boolean;
};

export type StreamHighlightRequest = {
  mode: "highlight";
  texts: readonly string[];
  rules: readonly StreamHighlightRule[];
};

export type HighlightRange = { start: number; end: number; rule: number };
export type StreamHighlightResult = {
  rows: HighlightRange[][];
  invalid: string[];
  limited?: true;
};

export function findStreamHighlights({
  texts,
  rules,
}: StreamHighlightRequest): StreamHighlightResult {
  if (
    rules.length > MAX_HIGHLIGHT_RULES ||
    texts.length > HIGHLIGHT_BATCH_ROWS ||
    texts.reduce((total, text) => total + text.length, 0) >
      HIGHLIGHT_BATCH_UNITS
  )
    return { rows: [], invalid: [], limited: true };

  const invalid: string[] = [];
  const patterns = rules.flatMap((rule, index) => {
    if (
      !rule.enabled ||
      !rule.pattern ||
      (!rule.foreground && !rule.background && !rule.bold)
    )
      return [];
    try {
      return [
        {
          index,
          pattern: compileStreamTextPattern(
            rule.pattern,
            rule.mode === "regex",
            true,
          ),
        },
      ];
    } catch {
      invalid.push(rule.id);
      return [];
    }
  });

  patterns.reverse();

  let limited = false;
  const rows = texts.map((text) => {
    const ranges: HighlightRange[] = [];
    if (!patterns.length || !text.length) return ranges;
    const coverage = new Uint8Array(text.length);
    // Paint lower-priority rules first, then replace each overlapping range.
    for (const { pattern, index } of patterns) {
      for (const match of text.matchAll(pattern)) {
        const end = match.index + match[0].length;
        if (match.index !== end) coverage.fill(index + 1, match.index, end);
      }
    }
    for (let start = 0; start < coverage.length;) {
      const rule = coverage[start]!;
      let end = start + 1;
      while (end < coverage.length && coverage[end] === rule) end++;
      if (rule) {
        if (ranges.length === MAX_RANGES_PER_ROW) {
          limited = true;
          break;
        }
        ranges.push({ start, end, rule: rule - 1 });
      }
      start = end;
    }
    return ranges;
  });
  return { rows, invalid, ...(limited ? { limited: true } : {}) };
}
