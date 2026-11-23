import type { IBufferLine, Terminal } from "@xterm/xterm";

export const MAX_ANSI_SEARCH_UNITS = 8_000_000;
export const MAX_ANSI_SEARCH_QUERY = 1024;
const MAX_MATCHES = 10_000;

export type AnsiSearchRequest = {
  mode: "ansi";
  lines: readonly string[];
  query: string;
  regex: boolean;
  caseSensitive: boolean;
};

export type AnsiSearchMatch = { line: number; start: number; end: number };
export type AnsiSearchResult = {
  matches: AnsiSearchMatch[];
  error?: "syntax" | "limit";
  truncated?: boolean;
};

export function findAnsiMatches({
  lines,
  query,
  regex,
  caseSensitive,
}: AnsiSearchRequest): AnsiSearchResult {
  const matches: AnsiSearchMatch[] = [];
  if (!query) return { matches };
  if (query.length > MAX_ANSI_SEARCH_QUERY) return { matches, error: "limit" };
  let pattern: RegExp;
  try {
    pattern = new RegExp(
      regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      `gu${caseSensitive ? "" : "i"}`,
    );
  } catch {
    return { matches, error: "syntax" };
  }
  for (const [line, text] of lines.entries()) {
    for (const match of text.matchAll(pattern)) {
      const length = match[0].length;
      if (!length) continue;
      if (matches.length === MAX_MATCHES) return { matches, truncated: true };
      matches.push({ line, start: match.index, end: match.index + length });
    }
  }
  return { matches };
}

type Row = { row: number; from: number; to: number };
type SearchLine = { text: string; rows: Row[] };

export function readAnsiSearchLines(
  terminal: Terminal,
): SearchLine[] | undefined {
  const buffer = terminal.buffer.active;
  const lines: SearchLine[] = [];
  let current: SearchLine = { text: "", rows: [] };
  let units = 0;
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (!line.isWrapped && current.rows.length) {
      lines.push(current);
      current = { text: "", rows: [] };
    }
    const next = buffer.getLine(row + 1);
    const wraps = next?.isWrapped === true;
    let columns = Math.min(terminal.cols, line.length);
    // A wide character can wrap early and leave one unused cell at the edge.
    if (
      wraps &&
      next.getCell(0)?.getWidth() === 2 &&
      !line.getCell(columns - 1)?.getChars()
    )
      columns--;
    const text = line.translateToString(!wraps, 0, columns);
    units += text.length;
    if (units > MAX_ANSI_SEARCH_UNITS) return;
    if (!text) continue;
    const from = current.text.length;
    current.text += text;
    current.rows.push({ row, from, to: current.text.length });
  }
  if (current.rows.length) lines.push(current);
  return lines;
}

function cellColumn(line: IBufferLine, offset: number, end: boolean) {
  for (let column = 0; column < line.length;) {
    const cell = line.getCell(column);
    if (!cell) return;
    const width = Math.max(1, cell.getWidth());
    const units = cell.getChars().length || 1;
    if (offset < units) return end ? column + width : column;
    offset -= units;
    column += width;
  }
}

export function locateAnsiMatch(
  terminal: Terminal,
  lines: readonly SearchLine[],
  match: AnsiSearchMatch,
) {
  const rows = lines[match.line]?.rows;
  const first = rows?.find(
    ({ from, to }) => from <= match.start && match.start < to,
  );
  const last = rows?.find(
    ({ from, to }) => from < match.end && match.end <= to,
  );
  if (!first || !last) return;
  const buffer = terminal.buffer.active;
  const firstLine = buffer.getLine(first.row);
  const lastLine = buffer.getLine(last.row);
  if (!firstLine || !lastLine) return;
  const column = cellColumn(firstLine, match.start - first.from, false);
  const end = cellColumn(lastLine, match.end - last.from - 1, true);
  if (column === undefined || end === undefined) return;
  return {
    column,
    row: first.row,
    length: (last.row - first.row) * terminal.cols + end - column,
  };
}
