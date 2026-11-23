import type { ReactNode } from "react";
import type { HighlightRange, StreamHighlightRule } from "./stream-highlight";

export function renderStreamHighlights(
  text: string,
  ranges: readonly HighlightRange[] | undefined,
  rules: readonly StreamHighlightRule[],
): ReactNode {
  if (!ranges?.length) return text;
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const { start, end, rule } of ranges) {
    const style = rules[rule]!;
    parts.push(
      text.slice(offset, start),
      <span
        key={start}
        data-stream-highlight={style.id}
        style={{
          color: style.foreground,
          backgroundColor: style.background,
          fontWeight: style.bold ? 700 : undefined,
        }}
      >
        {text.slice(start, end)}
      </span>,
    );
    offset = end;
  }
  parts.push(text.slice(offset));
  return parts;
}
