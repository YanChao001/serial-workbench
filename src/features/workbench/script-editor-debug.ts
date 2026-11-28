import {
  RangeSet,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  lineNumberMarkers,
  type DecorationSet,
} from "@codemirror/view";

type DebugMarks = { breakpoints: readonly number[]; activeLine?: number };
export const setScriptDebugMarks = StateEffect.define<DebugMarks>();

class ScriptBreakpoint extends GutterMarker {
  elementClass = "script-breakpoint";
}
const breakpoint = new ScriptBreakpoint();
const pausedLine = Decoration.line({ class: "script-paused-line" });

type MarkSets = {
  breakpoints: RangeSet<GutterMarker>;
  active: DecorationSet;
};

export const scriptDebugMarks = StateField.define<MarkSets>({
  create: () => ({ breakpoints: RangeSet.empty, active: Decoration.none }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setScriptDebugMarks)) continue;
      const { newDoc } = transaction;
      const { breakpoints, activeLine } = effect.value;
      return {
        breakpoints: RangeSet.of(
          breakpoints
            .filter((line) => line >= 1 && line <= newDoc.lines)
            .map((line) => breakpoint.range(newDoc.line(line).from)),
          true,
        ),
        active:
          activeLine && activeLine <= newDoc.lines
            ? Decoration.set([pausedLine.range(newDoc.line(activeLine).from)])
            : Decoration.none,
      };
    }
    return transaction.docChanged
      ? {
          breakpoints: value.breakpoints.map(transaction.changes),
          active: value.active.map(transaction.changes),
        }
      : value;
  },
  provide: (field) => [
    lineNumberMarkers.from(field, (value) => value.breakpoints),
    EditorView.decorations.from(field, (value) => value.active),
  ],
});

export function scriptLineOffset(doc: Text, line: number, column: number) {
  if (!Number.isInteger(line) || line < 1 || line > doc.lines) return;
  const location = doc.line(line);
  return Math.min(location.to, location.from + Math.max(0, column - 1));
}
