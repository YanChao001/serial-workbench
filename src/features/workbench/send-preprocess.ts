import {
  TX_MAX_BYTES,
  validateJsonValue,
  type Query,
  type TextEncoding,
} from "@serial-workbench/contracts";
import { bytesToBase64 } from "@/lib/base64";
import {
  createTextDecoder,
  encodeText,
  isTextEncoding,
  prepareTextEncoding,
} from "@/lib/text-encoding";

export const SEND_PREPROCESS_DEFINITION_LIMIT = 16 * 1024;
const MAX_STEPS = 8;

type Step =
  | { kind: "encoding"; from: TextEncoding; to: TextEncoding }
  | { kind: "json"; field: string; format: "text" | "base64" }
  | {
      kind: "query";
      actionId: string;
      input: string;
      output: string;
      params: Query["params"];
    };

export type SendPreprocessQuery = (
  actionId: string,
  params: Query["params"],
  signal: AbortSignal,
) => Promise<unknown>;

export class SendPreprocessError extends Error {
  constructor(
    readonly reason:
      "definition" | "encoding" | "empty" | "limit" | "query" | "output",
    readonly step?: number,
  ) {
    super(reason);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function readStep(value: unknown, index: number): Step {
  if (isObject(value)) {
    const { kind, from, to, field, format, actionId, input, output } = value;
    if (
      kind === "encoding" &&
      typeof from === "string" &&
      isTextEncoding(from) &&
      typeof to === "string" &&
      isTextEncoding(to) &&
      hasOnlyKeys(value, ["kind", "from", "to"])
    ) {
      return { kind, from, to };
    }
    if (
      kind === "json" &&
      isField(field) &&
      (format === "text" || format === "base64") &&
      hasOnlyKeys(value, ["kind", "field", "format"])
    ) {
      return { kind, field, format };
    }
    const params = value.params === undefined ? {} : value.params;
    if (
      kind === "query" &&
      isField(actionId) &&
      isField(input) &&
      isField(output) &&
      isObject(params) &&
      validateJsonValue(params) &&
      !Object.hasOwn(params, input) &&
      hasOnlyKeys(value, ["kind", "actionId", "input", "output", "params"])
    ) {
      return { kind, actionId, input, output, params };
    }
  }
  throw new SendPreprocessError("definition", index + 1);
}

function readSteps(definition: string): Step[] {
  if (definition.length > SEND_PREPROCESS_DEFINITION_LIMIT)
    throw new SendPreprocessError("definition");
  let value: unknown;
  try {
    value = JSON.parse(definition);
  } catch {
    throw new SendPreprocessError("definition");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STEPS)
    throw new SendPreprocessError("definition");
  return value.map(readStep);
}

async function transform(
  bytes: Uint8Array,
  step: Exclude<Step, { kind: "query" }>,
): Promise<Uint8Array> {
  const decoding = { fatal: true, ignoreBOM: true };
  if (step.kind === "encoding") {
    const text = createTextDecoder(step.from, decoding).decode(bytes);
    await prepareTextEncoding(step.to);
    return encodeText(text, step.to);
  }
  const value =
    step.format === "base64"
      ? bytesToBase64(bytes)
      : createTextDecoder("utf-8", decoding).decode(bytes);
  return encodeText(JSON.stringify({ [step.field]: value }), "utf-8");
}

async function transformWithQuery(
  bytes: Uint8Array,
  step: Extract<Step, { kind: "query" }>,
  index: number,
  signal: AbortSignal,
  query: SendPreprocessQuery | undefined,
): Promise<Uint8Array> {
  if (!query) throw new SendPreprocessError("query", index);
  let result: unknown;
  try {
    result = await query(
      step.actionId,
      { ...step.params, [step.input]: bytesToBase64(bytes) },
      signal,
    );
  } catch {
    signal.throwIfAborted();
    throw new SendPreprocessError("query", index);
  }
  signal.throwIfAborted();
  const encoded =
    isObject(result) && Object.hasOwn(result, step.output)
      ? result[step.output]
      : undefined;
  if (typeof encoded !== "string")
    throw new SendPreprocessError("output", index);
  if (encoded.length > Math.ceil(TX_MAX_BYTES / 3) * 4)
    throw new SendPreprocessError("limit", index);
  try {
    const decoded = Uint8Array.from(atob(encoded), (byte) =>
      byte.charCodeAt(0),
    );
    if (bytesToBase64(decoded) === encoded) return decoded;
  } catch {
    // atob rejects invalid input. The re-encode check also rejects noncanonical input.
  }
  throw new SendPreprocessError("output", index);
}

export async function runSendPreprocess(
  input: Uint8Array,
  definition: string,
  signal: AbortSignal,
  query?: SendPreprocessQuery,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (input.length > TX_MAX_BYTES) throw new SendPreprocessError("limit");
  const steps = readSteps(definition);
  let bytes: Uint8Array = input.slice();
  for (const [index, step] of steps.entries()) {
    if (step.kind === "query") {
      bytes = await transformWithQuery(bytes, step, index + 1, signal, query);
    } else {
      try {
        bytes = await transform(bytes, step);
      } catch {
        signal.throwIfAborted();
        throw new SendPreprocessError("encoding", index + 1);
      }
    }
    signal.throwIfAborted();
    if (bytes.length === 0) throw new SendPreprocessError("empty", index + 1);
    if (bytes.length > TX_MAX_BYTES)
      throw new SendPreprocessError("limit", index + 1);
  }
  return bytes;
}
