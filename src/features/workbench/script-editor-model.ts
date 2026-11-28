import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import type { TrustedScriptApi } from "@serial-workbench/plugin-sdk/node";

export type ScriptLanguage = "js" | "ts";

const sdkMembers = {
  serial: "TrustedScriptApi.serial",
  log: "(message: string) → void",
  delay: "(ms: number) → Promise<void>",
} satisfies Record<keyof TrustedScriptApi, string>;
const serialMembers = {
  read: "(startEventSeq: string) → Promise<StreamReadResult>",
  send: "(bytes: Uint8Array) → Promise<TxReceipt>",
} satisfies Record<keyof TrustedScriptApi["serial"], string>;

const memberOptions: Completion[] = Object.entries(serialMembers).map(
  ([label, detail]) => ({ label, detail, type: "method", boost: 10 }),
);
const sdkOptions: Completion[] = Object.entries(sdkMembers).map(
  ([label, detail]) => ({ label, detail, type: "variable", boost: 5 }),
);

export const completeScriptSdk: CompletionSource = (context) => {
  for (
    let node = syntaxTree(context.state).resolveInner(context.pos, -1);
    node.parent;
    node = node.parent
  ) {
    if (node.name === "Interpolation") break;
    if (
      /^(?:LineComment|BlockComment|String|TemplateString|RegExp)$/.test(
        node.name,
      )
    )
      return null;
  }
  const serial = context.matchBefore(/\bserial\.[\w$]*$/);
  const prefix = context.matchBefore(/[\w$]+$/);
  const from = serial
    ? serial.from + "serial.".length
    : (prefix?.from ?? context.pos);
  if (!serial && !prefix && !context.explicit) return null;
  // Another object's dot access should keep its own language completions.
  if (!serial && from > 0 && context.state.sliceDoc(from - 1, from) === ".")
    return null;
  return {
    from,
    options: serial ? memberOptions : sdkOptions,
    validFor: /^[\w$]*$/,
  };
};

export function scriptSyntaxDiagnostics(
  state: EditorState,
  message: string,
): Diagnostic[] {
  if (state.doc.length > 65_536) return [];
  const tree = ensureSyntaxTree(state, state.doc.length, 25);
  const diagnostics: Diagnostic[] = [];
  tree?.iterate({
    enter(node) {
      if (diagnostics.length >= 8) return false;
      if (node.type.isError && diagnostics.at(-1)?.from !== node.from)
        diagnostics.push({
          from: node.from,
          to: node.to,
          severity: "error",
          message,
        });
    },
  });
  return diagnostics;
}

export const scriptSnippets = [
  {
    id: "example",
    label: "scriptEditor.echo",
    text: (language: ScriptLanguage) =>
      (language === "ts"
        ? 'import type { TrustedScriptApi } from "@serial-workbench/plugin-sdk/node";\n\n'
        : "") +
      "export default async function run({ serial, log }" +
      (language === "ts" ? ": TrustedScriptApi" : "") +
      ") {\n  const receipt = await serial.send(new Uint8Array([0x00, 0xff]));\n  log(receipt.operationId);\n  return receipt;\n}\n",
  },
  { id: "log", label: "scriptEditor.log", text: () => 'log("echo");' },
  { id: "delay", label: "scriptEditor.delay", text: () => "await delay(100);" },
  {
    id: "read",
    label: "scriptEditor.read",
    text: () => 'await serial.read("1");',
  },
  {
    id: "send",
    label: "scriptEditor.send",
    text: () => "await serial.send(new Uint8Array([0x00, 0xff]));",
  },
] as const;
