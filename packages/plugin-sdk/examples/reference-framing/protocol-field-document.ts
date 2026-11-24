import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
} from "yaml";
import {
  compileProtocolFields,
  ProtocolFieldError,
} from "./protocol-fields.ts";

export const maxDefinitionLength = 16_384;
export type FieldDefinitionFormat = "json" | "yaml";

export class ProtocolDefinitionError extends ProtocolFieldError {
  readonly position: { line: number; column: number };

  constructor(
    path: string,
    detail: string,
    position: { line: number; col: number },
  ) {
    super(path, detail);
    this.name = "ProtocolDefinitionError";
    this.position = { line: position.line, column: position.col };
  }
}

export function compileProtocolFieldDocument(
  source: string,
  format: FieldDefinitionFormat,
) {
  const lines = new LineCounter();
  const offsets = new Map<string, number>();
  const fail = (path: string, message: string, offset: number): never => {
    const position = lines.linePos(offset);
    throw new ProtocolDefinitionError(
      path,
      message,
      position.line === 0 ? { line: 1, col: offset + 1 } : position,
    );
  };
  if (!source.trim() || source.length > maxDefinitionLength)
    fail("definition", "Expected a nonempty, bounded definition", 0);

  let document;
  try {
    document = parseDocument(source, {
      lineCounter: lines,
      merge: false,
      prettyErrors: false,
      resolveKnownTags: false,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: "1.2",
    });
  } catch (error) {
    if (error instanceof RangeError)
      return fail("definition", "Definition nesting is too deep", 0);
    throw error;
  }
  const diagnostic = document.errors[0] ?? document.warnings[0];
  if (diagnostic) fail("definition", diagnostic.code, diagnostic.pos[0]);
  if (document.directives?.yaml.explicit)
    fail("definition", "YAML version directives are unsupported", 0);

  function index(value: unknown, path: string, depth: number) {
    if (!isNode(value)) return;
    const offset = value.range?.[0] ?? 0;
    if (depth > 6) fail(path, "Definition nesting is too deep", offset);
    if (isAlias(value) || value.anchor || value.tag)
      fail(path, "Aliases, anchors and explicit tags are unsupported", offset);
    if (!offsets.has(path)) offsets.set(path, offset);
    if (isMap(value)) {
      for (const entry of value.items) {
        const key: unknown = entry.key;
        if (!isScalar(key) || typeof key.value !== "string")
          return fail(path, "Expected a string key", offset);
        const child = path ? `${path}.${key.value}` : key.value;
        index(key, child, depth + 1);
        index(entry.value, child, depth + 1);
      }
    } else if (isSeq(value)) {
      value.items.forEach((entry, entryIndex) => {
        index(entry, `${path}[${entryIndex}]`, depth + 1);
      });
    }
  }
  index(document.contents, "", 0);

  let definition: unknown;
  if (format === "yaml") {
    definition = document.toJS({ maxAliasCount: 0 });
  } else {
    try {
      definition = JSON.parse(source.replace(/^\uFEFF/, " "));
    } catch (error) {
      const match =
        error instanceof SyntaxError &&
        /\bposition (\d+)\b/.exec(error.message);
      fail(
        "definition",
        "Invalid JSON",
        match ? Number(match[1]) : source.length,
      );
    }
  }
  try {
    return { codec: compileProtocolFields(definition), definition };
  } catch (error) {
    if (!(error instanceof ProtocolFieldError)) throw error;
    let prefix = error.path.replace(/^definition\./, "");
    while (!offsets.has(prefix) && prefix.length > 0) {
      const split = Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf("["));
      prefix = split < 0 ? "" : prefix.slice(0, split);
    }
    return fail(error.path, error.message, offsets.get(prefix) ?? 0);
  }
}
