import { CLIENT_DRAFT_MAX_BYTES } from "@/lib/client-settings";

type CommandPart = string | { variable: string };

export function parseCommandTemplate(source: string) {
  const parts: CommandPart[] = [];
  const variables = new Set<string>();
  let offset = 0;
  for (const match of source.matchAll(/(\$)?\$\{([a-zA-Z_][\w.-]*)\}/g)) {
    const start = match.index;
    const name = match[2]!;
    if (start > offset) parts.push(source.slice(offset, start));
    if (match[1]) parts.push(match[0].slice(1));
    else {
      variables.add(name);
      parts.push({ variable: name });
    }
    offset = start + match[0].length;
  }
  if (offset < source.length) parts.push(source.slice(offset));
  return { parts, variables: [...variables] };
}

export function expandCommandTemplate(
  parts: readonly CommandPart[],
  values: ReadonlyMap<string, string>,
): { kind: "ready"; body: string } | { kind: "missing" | "limit" } {
  const chunks: string[] = [];
  let size = 0;
  for (const part of parts) {
    const value = typeof part === "string" ? part : values.get(part.variable);
    if (value === undefined) return { kind: "missing" };
    size += value.length;
    if (size > CLIENT_DRAFT_MAX_BYTES) return { kind: "limit" };
    chunks.push(value);
  }
  const body = chunks.join("");
  if (new TextEncoder().encode(body).length > CLIENT_DRAFT_MAX_BYTES)
    return { kind: "limit" };
  return { kind: "ready", body };
}
