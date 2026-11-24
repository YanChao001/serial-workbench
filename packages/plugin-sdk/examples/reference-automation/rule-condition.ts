import { createContext, Script } from "node:vm";
import {
  compileProtocolFields,
  ProtocolFieldError,
  type FieldReading,
} from "../reference-framing/protocol-fields.ts";

const maxLineBytes = 4096;
const regexBudgetMs = 25;
const decimalScale = 10n ** 18n;
const exactDecimal = /^-?(?:0|[1-9]\d{0,59})(?:\.\d{1,18})?$/;
const floatDecimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[-+]?\d+)?$/i;

type Condition = {
  framing:
    { kind: "line"; maxBytes: number } | { kind: "fixed"; byteLength: number };
  matches(frame: Uint8Array): boolean;
};

type Operator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

function isOperator(value: unknown): value is Operator {
  return (
    value === "eq" ||
    value === "ne" ||
    value === "gt" ||
    value === "gte" ||
    value === "lt" ||
    value === "lte"
  );
}

function compare<T extends string | number | bigint>(
  a: T,
  b: T,
  operator: Operator,
): boolean {
  switch (operator) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
  }
}

function fixedDecimal(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (
    negative ? value.slice(1) : value
  ).split(".");
  const magnitude =
    BigInt(whole) * decimalScale + BigInt(fraction.padEnd(18, "0"));
  return negative ? -magnitude : magnitude;
}

function compileRegex(definition: Record<string, unknown>): Condition {
  const { pattern, ignoreCase } = definition;
  if (
    Object.keys(definition).some(
      (key) => !["kind", "pattern", "ignoreCase"].includes(key),
    ) ||
    typeof pattern !== "string" ||
    !pattern.length ||
    pattern.length > 256 ||
    (ignoreCase !== undefined && typeof ignoreCase !== "boolean")
  ) {
    throw new Error("Invalid rule regular expression");
  }

  const input = { text: "" };
  const context = createContext(input, {
    codeGeneration: { strings: false, wasm: false },
  });
  const flags = ignoreCase ? "iu" : "u";
  try {
    new Script(
      "const expression = new RegExp(" +
        JSON.stringify(pattern) +
        ", " +
        JSON.stringify(flags) +
        ");",
    ).runInContext(context);
  } catch (error) {
    throw new Error("Invalid rule regular expression", { cause: error });
  }
  const match = new Script("expression.test(text)");
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return {
    framing: { kind: "line", maxBytes: maxLineBytes },
    matches(frame) {
      if (frame.byteLength > maxLineBytes) return false;
      try {
        input.text = utf8.decode(frame).replace(/\r$/, "");
      } catch {
        return false;
      }
      try {
        return match.runInContext(context, { timeout: regexBudgetMs }) === true;
      } finally {
        input.text = "";
      }
    },
  };
}

function fieldPredicate(
  kind: FieldReading["kind"],
  expected: string,
  operator: Operator,
) {
  if (kind === "integer" || kind === "bits") {
    if (expected.trim() !== expected || !exactDecimal.test(expected))
      throw new Error("Rule requires an exact decimal field threshold");
    const threshold = fixedDecimal(expected);
    return (value: string) =>
      exactDecimal.test(value) &&
      compare(fixedDecimal(value), threshold, operator);
  }
  if (kind === "float") {
    const threshold = Number(expected);
    if (
      expected.trim() !== expected ||
      !floatDecimal.test(expected) ||
      !Number.isFinite(threshold)
    )
      throw new Error("Rule requires a finite floating-point field threshold");
    return (value: string) => compare(Number(value), threshold, operator);
  }
  if (operator !== "eq" && operator !== "ne")
    throw new Error("Text and byte fields require equality or inequality");
  return (value: string) => compare(value, expected, operator);
}

function compileField(definition: Record<string, unknown>): Condition {
  const {
    fieldId,
    operator,
    expected,
    compare: source = "decoded",
  } = definition;
  if (
    Object.keys(definition).some(
      (key) =>
        ![
          "kind",
          "definition",
          "fieldId",
          "operator",
          "expected",
          "compare",
        ].includes(key),
    ) ||
    typeof fieldId !== "string" ||
    !isOperator(operator) ||
    typeof expected !== "string" ||
    expected.length > 4096 ||
    (source !== "decoded" && source !== "raw")
  ) {
    throw new Error("Invalid rule field condition");
  }
  const codec = compileProtocolFields(definition.definition);
  const fields = codec.decode(new Uint8Array(codec.byteLength));
  const index = fields.findIndex((field) => field.id === fieldId);

  const field = fields[index];
  if (!field) throw new Error("Unknown field in rule condition");
  if (
    field.kind === "checksum" ||
    (source === "raw" && field.rawValue === undefined)
  )
    throw new Error("Rule field does not expose the selected value");
  const accepts = fieldPredicate(field.kind, expected, operator);
  return {
    framing: { kind: "fixed", byteLength: codec.byteLength },
    matches(frame) {
      if (frame.byteLength !== codec.byteLength) return false;
      let decoded: FieldReading[];
      try {
        decoded = codec.decode(frame);
      } catch (error) {
        if (error instanceof ProtocolFieldError) return false;
        throw error;
      }
      if (decoded.some((reading) => reading.checksum?.valid === false))
        return false;
      const reading = decoded[index];
      if (!reading) return false;
      const value = source === "raw" ? reading.rawValue : reading.value;
      return (
        value !== undefined &&
        (source === "raw" || reading.calibration?.status !== "unmapped") &&
        accepts(value)
      );
    },
  };
}

export function compileRuleCondition(definition: unknown): Condition {
  if (
    typeof definition === "object" &&
    definition !== null &&
    !Array.isArray(definition)
  ) {
    const condition = definition as Record<string, unknown>;
    if (condition.kind === "regex") return compileRegex(condition);
    if (condition.kind === "field") return compileField(condition);
  }
  throw new Error("Rule requires a regex or protocol field condition");
}
