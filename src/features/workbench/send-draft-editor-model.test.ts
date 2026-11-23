import { expect, it } from "vitest";
import {
  indentSendDraft,
  sendDraftTokens,
  toggleSendDraftComment,
  type DraftEdit,
  type DraftSelection,
} from "./send-draft-editor-model";

const selection = (
  start: number,
  end: number,
  direction: DraftSelection["direction"] = "forward",
): DraftSelection => ({ start, end, direction });
const apply = (source: string, edit: DraftEdit) =>
  source.slice(0, edit.start) + edit.text + source.slice(edit.end);

it("indents only the touched lines and preserves backward selection across a trailing line break", () => {
  const source = "41\n42\n43";
  const edit = indentSendDraft(source, selection(1, 6, "backward"), false);
  expect(apply(source, edit)).toBe("  41\n  42\n43");
  expect(edit.selection).toEqual(selection(3, 10, "backward"));
  const reversed = indentSendDraft(apply(source, edit), edit.selection, true);
  expect(apply(apply(source, edit), reversed)).toBe(source);
  expect(reversed.selection).toEqual(selection(1, 6, "backward"));
});

it("outdents space and tab prefixes and keeps a caret inside the line", () => {
  const source = "\t01\n  02";
  const edit = indentSendDraft(source, selection(4, 4), true);
  expect(apply(source, edit)).toBe("\t01\n02");
  expect(edit.selection).toEqual(selection(4, 4));
});

it("toggles a complete block while rejecting a split quoted token or closing marker", () => {
  const source = '41\n"AB"\n43';
  const edit = toggleSendDraftComment(source, selection(3, 7, "backward"))!;
  const wrapped = apply(source, edit);
  expect(wrapped).toBe('41\n/*"AB"*/\n43');
  expect(edit.selection).toEqual(selection(5, 9, "backward"));
  expect(apply(wrapped, toggleSendDraftComment(wrapped, edit.selection)!)).toBe(
    source,
  );
  expect(toggleSendDraftComment(source, selection(4, 6))).toBeUndefined();
  expect(toggleSendDraftComment('"*/"', selection(0, 4))).toBeUndefined();
});

it("classifies multiline syntax and keeps comment-looking quoted content literal", () => {
  const source = '41\n/* skip\n42 */\n"/*literal*/" \\r';
  expect(sendDraftTokens(source, "text")).toEqual([]);
  expect(
    sendDraftTokens(source, "mixed").map(({ kind, start, end }) => [
      kind,
      source.slice(start, end),
    ]),
  ).toEqual([
    ["hex", "41"],
    ["comment", "/* skip\n42 */"],
    ["string", '"/*literal*/"'],
    ["escape", "\\r"],
  ]);
});
