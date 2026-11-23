import { hexByteBoundary, hexCharacter, type HexFormat } from "./stream-hex";

type SelectionEnd = { source: string; offset: bigint; ascii: boolean };
export type StreamHexSelection = {
  start: SelectionEnd;
  end: SelectionEnd;
  backwards: boolean;
};

function toByte(
  root: HTMLElement,
  text: Node,
  character: number,
  format: HexFormat,
  end: boolean,
): SelectionEnd | undefined {
  const element = text.parentElement;
  const source = element?.dataset.hexSource;
  const start = element?.dataset.hexByteStart;
  if (
    !source ||
    start === undefined ||
    !root.contains(element) ||
    text.nodeType !== Node.TEXT_NODE
  )
    return;
  const count = Number(element.dataset.hexByteCount);
  if (!count) return;
  const position = hexByteBoundary(character, count, format, end);
  return {
    source,
    offset: BigInt(start) + BigInt(position.byte),
    ascii: position.ascii,
  };
}

export function readStreamHexSelection(
  root: HTMLElement | null,
  format: HexFormat,
): StreamHexSelection | undefined {
  if (!root || root.hidden) return;
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const start = toByte(
    root,
    range.startContainer,
    range.startOffset,
    format,
    false,
  );
  const end = toByte(root, range.endContainer, range.endOffset, format, true);
  if (
    !start ||
    !end ||
    (start.source === end.source && start.offset >= end.offset)
  )
    return;
  const backwards =
    selection.anchorNode === range.endContainer &&
    selection.anchorOffset === range.endOffset;
  return { start, end, backwards };
}

type TextPosition = { text: Node; character: number };

function toCharacter(
  root: HTMLElement,
  boundary: SelectionEnd,
  format: HexFormat,
  end: boolean,
): TextPosition | undefined {
  const source = CSS.escape(boundary.source);
  const segments = root.querySelectorAll<HTMLElement>(
    '[data-hex-source="' + source + '"]',
  );
  let edge: TextPosition | undefined;
  for (const element of segments) {
    const start = element.dataset.hexByteStart;
    const text = element.firstChild;
    const count = Number(element.dataset.hexByteCount);
    if (
      start === undefined ||
      !count ||
      !text ||
      text.nodeType !== Node.TEXT_NODE
    )
      continue;
    const local = boundary.offset - BigInt(start);
    if (local < 0n || local > BigInt(count) || !element.getClientRects().length)
      continue;
    const byte = Number(local);
    const character = hexCharacter(
      { byte, ascii: boundary.ascii },
      count,
      format,
      end,
    );
    if (end ? byte > 0 : byte < count) return { text, character };
    edge ??= { text, character };
  }
  return edge;
}

export function restoreStreamHexSelection(
  root: HTMLElement | null,
  saved: StreamHexSelection,
  format: HexFormat,
) {
  if (!root?.isConnected || root.hidden) return;
  const start = toCharacter(root, saved.start, format, false);
  const end = toCharacter(root, saved.end, format, true);
  if (!start || !end) return;
  const [anchor, focus] = saved.backwards ? [end, start] : [start, end];
  root.ownerDocument
    .getSelection()
    ?.setBaseAndExtent(
      anchor.text,
      anchor.character,
      focus.text,
      focus.character,
    );
}
