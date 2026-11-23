export type SendDraftGrammar = "text" | "hex" | "mixed";
type TokenKind = "comment" | "string" | "escape" | "hex";
export type SendDraftToken = { start: number; end: number; kind: TokenKind };

export function mixedCommentEnd(source: string, start: number) {
  const end = source.indexOf("*/", start + 2);
  return end < 0 ? undefined : end + 2;
}

export function sendDraftTokens(
  source: string,
  grammar: SendDraftGrammar,
): SendDraftToken[] {
  if (grammar === "text") return [];
  // Each alternative consumes disjoint leading characters, including escapes in quotes.
  const expression =
    grammar === "hex"
      ? /[0-9a-f]{2}(?:\s*[0-9a-f]{2})*/gi
      : /\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\]|\\[\s\S])*(?:"|$)|\\(?:h\([^)]*\)|x[0-9a-f]{2}|[rnt0\\"])|<(?:CR|LF)>|0x[0-9a-f]{2}|[0-9a-f]{2}(?:[ \t]+[0-9a-f]{2})*/gi;
  return Array.from(source.matchAll(expression), (match) => {
    const token = match[0];
    const kind: TokenKind = token.startsWith("/")
      ? "comment"
      : token.startsWith('"')
        ? "string"
        : token.startsWith("\\") || token.startsWith("<")
          ? "escape"
          : "hex";
    return { start: match.index, end: match.index + token.length, kind };
  });
}

export type DraftSelection = {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
};
export type DraftEdit = {
  start: number;
  end: number;
  text: string;
  selection: DraftSelection;
};

function draftLines(source: string, { start, end }: DraftSelection) {
  const from = start === 0 ? 0 : source.lastIndexOf("\n", start - 1) + 1;
  const last = end > start && source[end - 1] === "\n" ? end - 1 : end;
  const newline = source.indexOf("\n", last);
  return { from, to: newline < 0 ? source.length : newline };
}

export function indentSendDraft(
  source: string,
  selection: DraftSelection,
  outdent: boolean,
): DraftEdit {
  const { from, to } = draftLines(source, selection);
  let offset = from;
  let { start, end } = selection;
  const text = source
    .slice(from, to)
    .split("\n")
    .map((line) => {
      const removed = outdent
        ? (line.match(/^(?:\t| {1,2})/)?.[0].length ?? 0)
        : 0;
      const inserted = outdent ? "" : "  ";
      if (selection.start >= offset)
        start += inserted.length - Math.min(removed, selection.start - offset);
      if (selection.end >= offset)
        end += inserted.length - Math.min(removed, selection.end - offset);
      offset += line.length + 1;
      return inserted + line.slice(removed);
    })
    .join("\n");
  return {
    start: from,
    end: to,
    text,
    selection: { ...selection, start, end },
  };
}

export function toggleSendDraftComment(
  source: string,
  selection: DraftSelection,
): DraftEdit | undefined {
  const { start, end, direction } = selection;
  const collapsed = start === end;
  const lines = collapsed ? draftLines(source, selection) : undefined;
  const from = lines?.from ?? start;
  const to = lines?.to ?? end;
  const tokens = sendDraftTokens(source, "mixed");
  const comment = tokens.find(
    (token) =>
      token.kind === "comment" &&
      ((collapsed && token.start <= start && start < token.end) ||
        (token.start === start && token.end === end) ||
        (token.start + 2 === start && token.end - 2 === end)),
  );
  if (comment && mixedCommentEnd(source, comment.start) === comment.end) {
    const text = source.slice(comment.start + 2, comment.end - 2);
    return {
      start: comment.start,
      end: comment.end,
      text,
      selection: {
        start: comment.start,
        end: comment.start + text.length,
        direction,
      },
    };
  }
  const selected = source.slice(from, to);
  if (
    !selected ||
    selected.includes("*/") ||
    tokens.some(
      (token) =>
        token.kind !== "hex" &&
        ((token.start < from && from < token.end) ||
          (token.start < to && to < token.end)),
    )
  )
    return;
  return {
    start: from,
    end: to,
    text: "/*" + selected + "*/",
    selection: { start: from + 2, end: to + 2, direction },
  };
}
