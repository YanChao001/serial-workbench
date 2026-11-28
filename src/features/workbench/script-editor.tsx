import {
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { autocompletion, closeCompletion } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
} from "@codemirror/commands";
import { javascript, localCompletionSource } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  forEachDiagnostic,
  linter,
  setDiagnosticsEffect,
} from "@codemirror/lint";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
} from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/providers/i18n";
import { dismissWorkbenchPopup } from "./workbench-dialog-exit";
import {
  completeScriptSdk,
  scriptSnippets,
  scriptSyntaxDiagnostics,
  type ScriptLanguage,
} from "./script-editor-model";
import "./script-editor.css";

const externalSource = Annotation.define<boolean>();
const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, class: "script-code-keyword" },
    { tag: [tags.string, tags.regexp], class: "script-code-string" },
    { tag: [tags.number, tags.bool, tags.null], class: "script-code-literal" },
    { tag: tags.comment, class: "script-code-comment" },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      class: "script-code-call",
    },
    {
      tag: [tags.typeName, tags.className, tags.propertyName],
      class: "script-code-property",
    },
  ]),
);

export type ScriptEditorHandle = { focus(): void };
type Report = { from: number; line: number; column: number };

export function ScriptEditor({
  ref,
  id,
  language,
  source,
  oversize,
  onChange,
}: {
  ref?: Ref<ScriptEditorHandle>;
  id: string;
  language: ScriptLanguage;
  source: string;
  oversize: boolean;
  onChange(source: string): void;
}) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const insertedFromMenu = useRef(false);
  const [lang] = useState(() => new Compartment());
  const [attrs] = useState(() => new Compartment());
  const [reports, setReports] = useState<Report[]>([]);
  const labelId = id + "-label";
  const bytesId = id + "-bytes";

  useImperativeHandle(
    ref,
    () => ({ focus: () => editor.current?.focus() }),
    [],
  );
  const syntaxMessage = useEffectEvent(() => t("scriptEditor.syntax"));
  const change = useEffectEvent((update: ViewUpdate) => {
    if (update.docChanged) {
      setReports([]);
      if (
        !update.transactions.some((transaction) =>
          transaction.annotation(externalSource),
        )
      )
        onChange(update.state.doc.toString());
    }
    if (
      update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setDiagnosticsEffect)),
      )
    ) {
      const next: Report[] = [];
      forEachDiagnostic(update.state, (_diagnostic, from) => {
        const line = update.state.doc.lineAt(from);
        next.push({ from, line: line.number, column: from - line.from + 1 });
      });
      setReports(next);
    }
  });

  useLayoutEffect(() => {
    if (!container.current) return;
    const view = new EditorView({
      parent: container.current,
      extensions: [
        lang.of([]),
        attrs.of([]),
        EditorState.tabSize.of(2),
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlight,
        EditorView.lineWrapping,
        autocompletion({
          override: [completeScriptSdk, localCompletionSource],
          maxRenderedOptions: 12,
          icons: false,
        }),
        EditorView.updateListener.of((update) => change(update)),
        keymap.of([...defaultKeymap, ...historyKeymap]),
      ],
    });
    editor.current = view;
    function dismiss(event: Event) {
      if (view.compositionStarted || closeCompletion(view))
        event.preventDefault();
    }
    view.contentDOM.addEventListener(dismissWorkbenchPopup, dismiss);
    return () => {
      view.contentDOM.removeEventListener(dismissWorkbenchPopup, dismiss);
      view.destroy();
      editor.current = null;
    };
  }, [lang, attrs]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || view.state.doc.toString() === source) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: source },
      annotations: [
        externalSource.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
  }, [source]);

  useLayoutEffect(() => {
    editor.current?.dispatch({
      effects: lang.reconfigure([
        javascript({ typescript: language === "ts" }),
        linter((view) => scriptSyntaxDiagnostics(view.state, syntaxMessage()), {
          delay: 180,
        }),
      ]),
    });
  }, [lang, language, t]);

  useLayoutEffect(() => {
    editor.current?.dispatch({
      effects: attrs.reconfigure([
        EditorView.contentAttributes.of({
          id,
          "aria-labelledby": labelId,
          "aria-describedby": bytesId,
          "aria-invalid": String(oversize),
          dir: "ltr",
        }),
        EditorState.phrases.of({
          Completions: t("scriptEditor.completions"),
          "Selection deleted": t("scriptEditor.selectionDeleted"),
        }),
      ]),
    });
  }, [attrs, id, labelId, bytesId, oversize, t]);

  function insert(snippet: (typeof scriptSnippets)[number]) {
    const view = editor.current;
    if (!view) return;
    view.dispatch({
      ...view.state.replaceSelection(snippet.text(language)),
      annotations: isolateHistory.of("full"),
      scrollIntoView: true,
      userEvent: "input",
    });
    view.focus();
  }

  function locate(from: number) {
    const view = editor.current;
    if (!view) return;
    view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
    view.focus();
  }

  return (
    <div className="grid min-w-0 gap-2 @container/script-source">
      <div className="grid min-w-0 items-start gap-2 @min-[36rem]/script-source:grid-cols-[9rem_minmax(0,1fr)]">
        <div className="hidden min-w-0 flex-col gap-1 @min-[36rem]/script-source:flex">
          <span className="px-2 text-sm font-medium">
            {t("scriptEditor.snippets")}
          </span>
          {scriptSnippets.map((snippet) => (
            <Button
              key={snippet.id}
              size="sm"
              variant="ghost"
              className="justify-start"
              disabled={snippet.id === "example" && Boolean(source.trim())}
              onClick={() => insert(snippet)}
            >
              {t(snippet.label)}
            </Button>
          ))}
        </div>
        <div className="@min-[36rem]/script-source:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                {t("scriptEditor.insert")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              onCloseAutoFocus={(event) => {
                if (!insertedFromMenu.current) return;
                insertedFromMenu.current = false;
                event.preventDefault();
                editor.current?.focus();
              }}
            >
              {scriptSnippets.map((snippet) => (
                <DropdownMenuItem
                  key={snippet.id}
                  disabled={snippet.id === "example" && Boolean(source.trim())}
                  onSelect={() => {
                    insertedFromMenu.current = true;
                    insert(snippet);
                  }}
                >
                  {t(snippet.label)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <span id={labelId} className="text-sm font-medium">
            {t("trustedScript.source")}
          </span>
          <div ref={container} className="script-source-editor" />
          {reports.length > 0 && (
            <ul
              aria-label={t("scriptEditor.problems")}
              className="grid min-w-0 gap-1"
            >
              {reports.map((report) => (
                <li key={report.from}>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-auto max-w-full whitespace-normal text-start text-destructive"
                    onClick={() => locate(report.from)}
                  >
                    {t("scriptEditor.problem", {
                      line: report.line,
                      column: report.column,
                    })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
