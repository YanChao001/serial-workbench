import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { cn } from "cn";
import {
  matchesShortcut,
  REDO_EDIT_ALTERNATE,
  REDO_EDIT_SHORTCUT,
  UNDO_EDIT_SHORTCUT,
  type Shortcut,
} from "@/commands/shortcuts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CLIENT_DRAFT_MAX_BYTES } from "@/lib/client-settings";
import { isMacOS } from "@/lib/platform";
import {
  indentSendDraft,
  sendDraftTokens,
  toggleSendDraftComment,
  type DraftEdit,
  type DraftSelection,
  type SendDraftGrammar,
} from "./send-draft-editor-model";

const INDENT: Shortcut = { key: "]", primary: true, allowInEditable: true };
const OUTDENT: Shortcut = { key: "[", primary: true, allowInEditable: true };
const COMMENT: Shortcut = { key: "/", primary: true, allowInEditable: true };

const FALLBACK_HISTORY = 24;

type Command = "indent" | "outdent" | "comment";
type Snapshot = { value: string; selection: DraftSelection };
type NativeFallback = { before: Snapshot; after: Snapshot };
type DraftEditorProps = Omit<
  ComponentProps<"textarea">,
  "value" | "defaultValue" | "onChange" | "wrap"
> & {
  value: string;
  onValueChange: (value: string) => void;
  grammar: SendDraftGrammar;
  editLabels?: {
    indent: string;
    outdent: string;
    comment: string;
    invalidComment: string;
  };
};

function restoreSelection(
  input: HTMLTextAreaElement,
  selection: DraftSelection,
) {
  input.setSelectionRange(selection.start, selection.end, selection.direction);
}

export function SendDraftEditor({
  value,
  onValueChange,
  grammar,
  editLabels,
  className,
  style,
  ref: providedRef,
  onKeyDown,
  onScroll,
  maxLength,
  ...props
}: DraftEditorProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const backdrop = useRef<HTMLPreElement>(null);
  const displayed = useRef<string | undefined>(undefined);
  const history = useRef<{ undo: NativeFallback[]; redo: NativeFallback[] }>({
    undo: [],
    redo: [],
  });
  const [invalidComment, setInvalidComment] = useState(false);
  const inputRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      input.current = element;
      if (typeof providedRef === "function") return providedRef(element);
      if (providedRef) providedRef.current = element;
    },
    [providedRef],
  );

  function publish(next: string) {
    if (displayed.current === next) return;
    displayed.current = next;
    setInvalidComment(false);
    onValueChange(next);
  }

  const syncScroll = useCallback((target: HTMLTextAreaElement) => {
    if (gutter.current)
      gutter.current.style.transform =
        "translateY(" + -target.scrollTop + "px)";
    if (backdrop.current)
      backdrop.current.style.transform =
        "translate(" + -target.scrollLeft + "px, " + -target.scrollTop + "px)";
  }, []);

  useLayoutEffect(() => {
    const target = input.current;
    if (!target) return;
    if (displayed.current !== value) {
      if (target.value !== value) target.value = value;
      displayed.current = value;
      history.current = { undo: [], redo: [] };
    }
    syncScroll(target);
  }, [grammar, syncScroll, value]);

  function perform(command: Command) {
    const target = input.current;
    if (!target || target.readOnly || target.disabled) return;
    const selection = {
      start: target.selectionStart,
      end: target.selectionEnd,
      direction: target.selectionDirection,
    };
    const before = target.value;
    const edit: DraftEdit | undefined =
      command === "comment"
        ? toggleSendDraftComment(before, selection)
        : indentSendDraft(before, selection, command === "outdent");
    if (!edit) {
      setInvalidComment(true);
      target.focus();
      return;
    }
    if (before.slice(edit.start, edit.end) === edit.text) return;
    // Keep the selection intact if the whole transaction would exceed the draft limit.
    if (
      before.length + edit.text.length - (edit.end - edit.start) >
      (maxLength ?? CLIENT_DRAFT_MAX_BYTES)
    )
      return;
    target.focus();
    target.setSelectionRange(edit.start, edit.end, selection.direction);
    // insertText/delete keep the browser's undo buffer for the native textarea.
    target.ownerDocument.execCommand?.(
      edit.text ? "insertText" : "delete",
      false,
      edit.text,
    );
    if (target.value === before) {
      target.setRangeText(edit.text, edit.start, edit.end);
      const { undo } = history.current;
      undo.push({
        before: { value: before, selection },
        after: { value: target.value, selection: edit.selection },
      });
      if (undo.length > FALLBACK_HISTORY) undo.shift();
      history.current.redo = [];
    }
    restoreSelection(target, edit.selection);
    publish(target.value);
    syncScroll(target);
  }

  function restoreFallback(direction: "undo" | "redo") {
    const target = input.current;
    const historyEntries = history.current[direction];
    const entry = historyEntries.at(-1);
    if (!target || !entry) return false;
    const prior = direction === "undo" ? entry.after : entry.before;
    if (prior.value !== target.value) return false;
    const next = direction === "undo" ? entry.before : entry.after;
    historyEntries.pop();
    history.current[direction === "undo" ? "redo" : "undo"].push(entry);
    target.value = next.value;
    restoreSelection(target, next.selection);
    publish(next.value);
    syncScroll(target);
    return true;
  }

  const source = useMemo(() => value.replace(/\r\n?/g, "\n"), [value]);
  const numbers = useMemo(
    () =>
      source
        .split("\n")
        .map((_, index) => index + 1)
        .join("\n"),
    [source],
  );
  const painted = useMemo(() => {
    const tokens = sendDraftTokens(source, grammar);
    if (!tokens.length) return undefined;
    let offset = 0;
    const parts = tokens.flatMap(({ start, end, kind }) => {
      const gap = source.slice(offset, start);
      offset = end;
      return [
        gap,
        <span key={start} data-source-token={kind}>
          {source.slice(start, end)}
        </span>,
      ];
    });
    return [...parts, source.slice(offset)];
  }, [grammar, source]);
  // A draft without line breaks keeps the soft wrapping of the plain send field.
  const softWrap = !source.includes("\n");
  const editor = (
    <div
      className="workbench-source-editor"
      data-syntax={painted ? "" : undefined}
      data-soft-wrap={softWrap || undefined}
      style={style}
    >
      <div className="workbench-source-gutter" aria-hidden="true">
        <pre ref={gutter} className="workbench-source-lines">
          {numbers}
        </pre>
      </div>
      <div className="workbench-source-canvas">
        {painted && (
          <div className="workbench-source-backdrop" aria-hidden="true">
            <pre ref={backdrop} className="workbench-source-ink">
              {painted}
            </pre>
          </div>
        )}
        <Textarea
          {...props}
          ref={inputRef}
          className={cn("workbench-draft", className)}
          style={style}
          maxLength={maxLength}
          wrap={softWrap ? "soft" : "off"}
          aria-keyshortcuts={["]", "[", ...(grammar === "mixed" ? ["/"] : [])]
            .map((key) => (isMacOS() ? "Meta+" : "Control+") + key)
            .join(" ")}
          onChange={(event) => {
            history.current = { undo: [], redo: [] };
            publish(event.currentTarget.value);
            syncScroll(event.currentTarget);
          }}
          onScroll={(event) => {
            syncScroll(event.currentTarget);
            onScroll?.(event);
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.currentTarget.readOnly || event.currentTarget.disabled)
              return;
            const key = event.nativeEvent;
            if (matchesShortcut(key, INDENT)) {
              event.preventDefault();
              perform("indent");
            } else if (matchesShortcut(key, OUTDENT)) {
              event.preventDefault();
              perform("outdent");
            } else if (grammar === "mixed" && matchesShortcut(key, COMMENT)) {
              event.preventDefault();
              perform("comment");
            } else if (
              matchesShortcut(key, UNDO_EDIT_SHORTCUT) &&
              restoreFallback("undo")
            ) {
              event.preventDefault();
            } else if (
              (matchesShortcut(key, REDO_EDIT_SHORTCUT) ||
                matchesShortcut(key, REDO_EDIT_ALTERNATE)) &&
              restoreFallback("redo")
            ) {
              event.preventDefault();
            }
          }}
        />
      </div>
    </div>
  );

  if (!editLabels) return editor;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1">
        {(["indent", "outdent", "comment"] as const).map((command) => (
          <Button
            key={command}
            type="button"
            size="sm"
            variant="outline"
            disabled={props.readOnly || props.disabled}
            onClick={() => perform(command)}
          >
            {editLabels[command]}
          </Button>
        ))}
      </div>
      <div className="workbench-mixed-source" data-surface="reading">
        {editor}
      </div>
      {invalidComment && <p role="status">{editLabels.invalidComment}</p>}
    </div>
  );
}
