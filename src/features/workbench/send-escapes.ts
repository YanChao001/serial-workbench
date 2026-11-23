import type { TextEncoding } from "@serial-workbench/contracts";
import { formatHex, parseHex } from "@serial-workbench/host-client";
import { encodeText } from "@/lib/text-encoding";
import { CLIENT_DRAFT_MAX_BYTES } from "@/lib/client-settings";

// Client state accepts 65,536 characters in one draft. Each byte uses two digits and a separator.
const MAX_HEX_DRAFT_BYTES = Math.floor((CLIENT_DRAFT_MAX_BYTES + 1) / 3);
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  r: 13,
  n: 10,
  t: 9,
  "0": 0,
  "\\": 92,
  '"': 34,
};

export class SendEscapeError extends Error {
  constructor(
    public readonly kind: "syntax" | "limit",
    public readonly start: number,
    public readonly end: number,
  ) {
    super(kind);
  }
}

function escapedByte(draft: string, start: number, bare: boolean) {
  const digits = draft.slice(start + 2, start + 4);
  const end = Math.min(start + 4, draft.length);
  let selectionEnd = end;
  if (bare) {
    while (/\w/.test(draft[selectionEnd] ?? "")) selectionEnd += 1;
  }
  if (!/^[a-f0-9]{2}$/i.test(digits) || selectionEnd > end) {
    throw new SendEscapeError("syntax", start, selectionEnd);
  }
  return Uint8Array.of(Number.parseInt(digits, 16));
}

export function readSendEscape(draft: string, start: number, marker: string) {
  if (marker.startsWith("<")) {
    return {
      bytes: Uint8Array.of(marker.toLowerCase() === "<cr>" ? 13 : 10),
      end: start + 4,
    };
  }
  if (marker.toLowerCase() === "0x") {
    return { bytes: escapedByte(draft, start, true), end: start + 4 };
  }
  const kind = draft[start + 1] ?? "";
  const simple = SIMPLE_ESCAPES[kind];
  if (simple !== undefined)
    return { bytes: Uint8Array.of(simple), end: start + 2 };
  if (kind === "x")
    return { bytes: escapedByte(draft, start, false), end: start + 4 };
  if (draft.startsWith("\\h(", start)) {
    const close = draft.indexOf(")", start + 3);
    if (close < 0) throw new SendEscapeError("syntax", start, draft.length);
    try {
      const bytes = parseHex(draft.slice(start + 3, close));
      if (bytes.length) return { bytes, end: close + 1 };
    } catch {
      // The selection identifies the whole group for replacement.
    }
    throw new SendEscapeError("syntax", start, close + 1);
  }
  throw new SendEscapeError("syntax", start, Math.min(start + 2, draft.length));
}

export function createHexDraft() {
  const result: number[] = [];
  function append(bytes: Uint8Array, start: number, end: number) {
    if (result.length + bytes.length > MAX_HEX_DRAFT_BYTES) {
      throw new SendEscapeError("limit", start, end);
    }
    for (const byte of bytes) result.push(byte);
  }
  return { append, format: () => formatHex(Uint8Array.from(result)) };
}

/** Explicitly expands escapes in the draft body. A send line ending is still added at send time. */
export function expandSendEscapes(
  draft: string,
  encoding: TextEncoding,
): string {
  const { append, format } = createHexDraft();
  let position = 0;
  for (const match of draft.matchAll(/\\|<(?:CR|LF)>|(?<!\w)0x/gi)) {
    if (match.index < position) continue;
    append(
      encodeText(draft.slice(position, match.index), encoding),
      position,
      match.index,
    );
    const { bytes, end } = readSendEscape(draft, match.index, match[0]);
    append(bytes, match.index, end);
    position = end;
  }
  append(encodeText(draft.slice(position), encoding), position, draft.length);
  return format();
}
