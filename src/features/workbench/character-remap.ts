import type {
  CharacterRemapRules as WireCharacterRemapRules,
  TransformReference,
} from "@serial-workbench/contracts";

export type CharacterRemapRules = Omit<
  WireCharacterRemapRules,
  "replacements"
> & {
  replacements: Readonly<WireCharacterRemapRules["replacements"]>;
};

export async function characterRemapTransform(
  mapping: WireCharacterRemapRules,
): Promise<TransformReference> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(mapping)),
    ),
  );
  return {
    id: "terminal.character-remap",
    version: "1",
    configurationDigest: Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

export const characterRemapLimits = {
  replacements: 16,
  replacementLength: 32,
  previewInput: 8192,
  previewOutput: 32768,
} as const;

type RowIssue = { row: number; code: "source" | "duplicate" | "replacement" };

type CharacterRemapResult =
  | { ok: true; text: string }
  | { ok: false; code: "rows"; issues: readonly RowIssue[] }
  | { ok: false; code: "tooMany" | "output" };

const unpairedSurrogate = /[\uD800-\uDFFF]/u;
const newlineText = { lf: "\n", cr: "\r", crlf: "\r\n" } as const;

/** 按原文的换行与退格分界，对每个原始字符至多替换一次。 */
export function remapCharacters(
  input: string,
  rules: CharacterRemapRules,
  maxOutput: number,
): CharacterRemapResult {
  if (rules.replacements.length > characterRemapLimits.replacements)
    return { ok: false, code: "tooMany" };
  const replacements = new Map<string, string>();
  const issues: RowIssue[] = [];
  for (const [row, { source, replacement }] of rules.replacements.entries()) {
    if (
      !source ||
      [...source].length !== 1 ||
      unpairedSurrogate.test(source) ||
      source === "\r" ||
      source === "\n" ||
      source === "\b"
    )
      issues.push({ code: "source", row });
    else if (replacements.has(source)) issues.push({ code: "duplicate", row });
    else {
      if (
        replacement.length > characterRemapLimits.replacementLength ||
        unpairedSurrogate.test(replacement)
      )
        issues.push({ code: "replacement", row });
      replacements.set(source, replacement);
    }
  }
  if (issues.length > 0) return { ok: false, code: "rows", issues };

  const output: string[] = [];
  let lineStart = 0;
  let length = 0;
  for (const [character] of input.matchAll(/\r\n|./gsu)) {
    let mapped: string;
    if (character === "\r" || character === "\n" || character === "\r\n") {
      mapped =
        rules.newline === "keep" ? character : newlineText[rules.newline];
      lineStart = output.length + 1;
    } else if (character === "\b" && rules.backspace !== "keep") {
      if (rules.backspace === "apply" && output.length > lineStart)
        length -= output.pop()?.length ?? 0;
      continue;
    } else {
      const replacement = replacements.get(character) ?? character;
      mapped =
        rules.letterCase === "upper"
          ? replacement.toUpperCase()
          : rules.letterCase === "lower"
            ? replacement.toLowerCase()
            : replacement;
    }
    output.push(mapped);
    length += mapped.length;
  }
  return length > maxOutput
    ? { ok: false, code: "output" }
    : { ok: true, text: output.join("") };
}
