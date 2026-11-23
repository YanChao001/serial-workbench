import type { TextEncoding } from "@serial-workbench/contracts";
import { encodeText } from "@/lib/text-encoding";
import {
  createHexDraft,
  readSendEscape,
  SendEscapeError,
} from "./send-escapes";

/** Converts an explicit mix of byte tokens and double-quoted text to a HEX draft. */
export function convertMixedSendDraft(
  draft: string,
  encoding: TextEncoding,
): string {
  const { append, format } = createHexDraft();
  const tokens = /\s+|"|\\|<(?:CR|LF)>|0x|[0-9a-f]{2}(?![\p{L}\p{N}_])/iuy;
  const quoted = /[^"\\]+/y;
  let position = 0;

  function readEscape(marker: string) {
    const { bytes, end } = readSendEscape(draft, position, marker);
    append(bytes, position, end);
    position = end;
  }

  function readQuotedText() {
    const start = position;
    position += 1;
    while (position < draft.length) {
      const current = draft.charAt(position);
      if (current === '"') {
        position += 1;
        return;
      }
      if (current === "\\") {
        const escaped = draft.charAt(position + 1);
        if (escaped === '"' || escaped === "\\") {
          append(encodeText(escaped, encoding), position, position + 2);
          position += 2;
        } else {
          readEscape(current);
        }
      } else {
        quoted.lastIndex = position;
        const text = quoted.exec(draft)?.[0] ?? current;
        append(encodeText(text, encoding), position, position + text.length);
        position += text.length;
      }
    }
    throw new SendEscapeError("syntax", start, draft.length);
  }

  while (position < draft.length) {
    tokens.lastIndex = position;
    const token = tokens.exec(draft)?.[0];
    if (!token) {
      const invalid = /^(?:[^\s"\\<]+|.)/u.exec(draft.slice(position))?.[0];
      throw new SendEscapeError(
        "syntax",
        position,
        position + (invalid?.length ?? 1),
      );
    }
    if (token === '"') readQuotedText();
    else if (token === "\\" || token.startsWith("<") || /^0x$/i.test(token))
      readEscape(token);
    else {
      if (/^[0-9a-f]{2}$/i.test(token))
        append(
          Uint8Array.of(Number.parseInt(token, 16)),
          position,
          tokens.lastIndex,
        );
      position = tokens.lastIndex;
    }
  }
  return format();
}
