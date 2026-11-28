import { CompletionContext } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { completeScriptSdk } from "./script-editor-model";

async function completions(doc: string) {
  const state = EditorState.create({ doc, extensions: javascript() });
  const result = await completeScriptSdk(
    new CompletionContext(state, doc.length, true),
  );
  return result?.options.map((option) => option.label) ?? [];
}

test("SDK completion belongs to direct serial access, including optional chaining", async () => {
  expect(await completions("await serial.s")).toEqual(["read", "send"]);
  expect(await completions("await serial.")).toEqual(["read", "send"]);
  expect(await completions("await serial ?. se")).toEqual(["read", "send"]);
  expect(await completions("await other.serial.s")).toEqual([]);
  expect(await completions("await other . serial.s")).toEqual([]);
  expect(await completions('const quoted = "serial.s')).toEqual([]);
});
