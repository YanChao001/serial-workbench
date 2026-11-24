import {
  commandVariablePattern,
  expandCommandTemplate,
  parseCommandTemplate,
} from "../../src/command-template.ts";
import { parseHex } from "../../src/hex.ts";
import { repeatSendFrameBytes } from "./repeat-send-settings.ts";

export const commandSequenceAction = "swb.reference.automation.sequence";
export const builtinCommandSequenceAction = "swb.builtin.automation.sequence";
export const commandSequenceMaxBytes = 32_768;
export const commandSequenceFrameBytes = repeatSendFrameBytes;
export const commandSequenceMaxWriteWaitMs = 5000;
const maxExpandedSteps = 64;
const maxDepth = 5;
const maxDelayMs = 60_000;
const maxTotalDelayMs = 120_000;
const maxHexText = repeatSendFrameBytes * 4;

export class CommandSequenceError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(path + ": " + message);
    this.name = "CommandSequenceError";
    this.path = path;
  }
}

export type CommandSequenceStep =
  | { kind: "delay"; path: string; milliseconds: number }
  | {
      kind: "send";
      path: string;
      bytes: Uint8Array;
      writeWaitMs?: number;
      expect?: Expectation;
    };

type Expectation = {
  bytes: Uint8Array;
  timeoutMs: number;
  onMatch?: readonly CommandSequenceStep[];
  onTimeout?: readonly CommandSequenceStep[];
};
type Plan = { steps: CommandSequenceStep[]; maxSteps: number; waitMs: number };
type Variables = ReadonlyMap<string, string>;
type CompileContext = { variables: Variables; allowReply: boolean };

function fail(path: string, message: string): never {
  throw new CommandSequenceError(path, message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "Expected an object");
  return value as Record<string, unknown>;
}

function fields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail(path, "Unknown property");
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  )
    fail(path, "Expected an integer in the supported range");
  return value;
}

function frame(value: unknown, variables: Variables, path: string) {
  if (typeof value !== "string" || value.length > maxHexText)
    fail(path, "Expected a HEX byte template");
  const expanded = expandCommandTemplate(
    parseCommandTemplate(value).parts,
    variables,
    maxHexText,
  );
  if (expanded.kind === "missing") fail(path, "A template variable is missing");
  if (expanded.kind !== "ready") fail(path, "The expanded frame is too long");
  let bytes: Uint8Array;
  try {
    bytes = parseHex(expanded.body);
  } catch {
    fail(path, "Use complete HEX bytes separated by ASCII whitespace");
  }
  if (!bytes.length || bytes.length > repeatSendFrameBytes)
    fail(path, "The number of bytes is outside the supported range");
  return bytes;
}

function budget(count: number, waitMs: number, path: string) {
  if (count > maxExpandedSteps)
    fail(path, "The expanded sequence has too many steps");
  if (waitMs > maxTotalDelayMs)
    fail(path, "The cumulative wait exceeds the sequence limit");
}

function compileStep(
  input: unknown,
  path: string,
  context: CompileContext,
  depth: number,
): Plan {
  const { variables, allowReply } = context;
  const step = object(input, path);
  switch (step.kind) {
    case "send": {
      fields(step, ["kind", "hex", "writeWaitMs", "expect"], path);
      const bytes = frame(step.hex, variables, path + ".hex");
      const writeWaitMs = Object.hasOwn(step, "writeWaitMs")
        ? integer(
            step.writeWaitMs,
            1,
            commandSequenceMaxWriteWaitMs,
            path + ".writeWaitMs",
          )
        : undefined;
      const sending: CommandSequenceStep = {
        kind: "send",
        path,
        bytes,
        ...(writeWaitMs !== undefined && { writeWaitMs }),
      };
      if (!Object.hasOwn(step, "expect"))
        return {
          steps: [sending],
          maxSteps: 1,
          waitMs: writeWaitMs ?? 0,
        };
      if (!allowReply)
        fail(
          path + ".expect",
          "The timeout fallback cannot wait for another reply",
        );
      const expectation = object(step.expect, path + ".expect");
      fields(
        expectation,
        ["hex", "timeoutMs", "onMatch", "onTimeout"],
        path + ".expect",
      );
      const reply = frame(expectation.hex, variables, path + ".expect.hex");
      const timeoutMs = integer(
        Object.hasOwn(expectation, "timeoutMs") ? expectation.timeoutMs : 1000,
        50,
        5000,
        path + ".expect.timeoutMs",
      );
      const branch = (key: "onMatch" | "onTimeout") =>
        Object.hasOwn(expectation, key)
          ? compileSteps(
              expectation[key],
              path + ".expect." + key,
              { variables, allowReply: key === "onMatch" },
              depth + 1,
            )
          : undefined;
      const onMatch = branch("onMatch");
      const onTimeout = branch("onTimeout");
      const expect = {
        bytes: reply,
        timeoutMs,
        onMatch: onMatch?.steps,
        onTimeout: onTimeout?.steps,
      };
      const maxSteps =
        1 + Math.max(onMatch?.maxSteps ?? 0, onTimeout?.maxSteps ?? 0);
      const waitMs =
        (writeWaitMs ?? 0) +
        timeoutMs +
        Math.max(onMatch?.waitMs ?? 0, onTimeout?.waitMs ?? 0);
      budget(maxSteps, waitMs, path);
      return {
        steps: [{ ...sending, expect }],
        maxSteps,
        waitMs,
      };
    }
    case "delay": {
      fields(step, ["kind", "milliseconds"], path);
      const milliseconds = integer(
        step.milliseconds,
        1,
        maxDelayMs,
        path + ".milliseconds",
      );
      return {
        steps: [{ kind: "delay", path, milliseconds }],
        maxSteps: 1,
        waitMs: milliseconds,
      };
    }
    case "repeat": {
      fields(step, ["kind", "count", "steps"], path);
      const count = integer(step.count, 1, maxExpandedSteps, path + ".count");
      const body = compileSteps(
        step.steps,
        path + ".steps",
        context,
        depth + 1,
      );
      const maxSteps = count * body.maxSteps;
      const waitMs = count * body.waitMs;
      budget(maxSteps, waitMs, path);
      return {
        steps: Array.from({ length: count }, () => body.steps).flat(),
        maxSteps,
        waitMs,
      };
    }
    case "if": {
      fields(step, ["kind", "variable", "equals", "then", "else"], path);
      const actual =
        typeof step.variable === "string"
          ? variables.get(step.variable)
          : undefined;
      if (actual === undefined)
        fail(path + ".variable", "Use a defined sequence variable");
      if (typeof step.equals !== "string")
        fail(path + ".equals", "Expected a literal string");
      const yes = compileSteps(step.then, path + ".then", context, depth + 1);
      const no = Object.hasOwn(step, "else")
        ? compileSteps(step.else, path + ".else", context, depth + 1)
        : { steps: [], maxSteps: 0, waitMs: 0 };
      return actual === step.equals ? yes : no;
    }
    default:
      return fail(path + ".kind", "Unknown sequence step");
  }
}

function compileSteps(
  input: unknown,
  path: string,
  context: CompileContext,
  depth: number,
): Plan {
  if (depth > maxDepth) fail(path, "The sequence is nested too deeply");
  if (!Array.isArray(input) || !input.length || input.length > maxExpandedSteps)
    fail(path, "Expected a nonempty step list within the sequence limit");
  const steps: CommandSequenceStep[] = [];
  let maxSteps = 0;
  let waitMs = 0;
  for (const [index, value] of input.entries()) {
    const position = path + "[" + index + "]";
    const next = compileStep(value, position, context, depth);
    maxSteps += next.maxSteps;
    waitMs += next.waitMs;
    budget(maxSteps, waitMs, position);
    steps.push(...next.steps);
  }
  return { steps, maxSteps, waitMs };
}

export function compileCommandSequence(definition: unknown) {
  if (
    typeof definition !== "string" ||
    definition.length > commandSequenceMaxBytes ||
    new TextEncoder().encode(definition).length > commandSequenceMaxBytes
  )
    fail("$", "Expected a bounded UTF-8 JSON definition");
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch {
    fail("$", "Invalid JSON definition");
  }
  const document = object(parsed, "$");
  fields(document, ["version", "variables", "steps"], "$");
  if (document.version !== 1) fail("$.version", "Unsupported sequence version");
  const variables = new Map<string, string>();
  if (Object.hasOwn(document, "variables")) {
    for (const [name, value] of Object.entries(
      object(document.variables, "$.variables"),
    )) {
      if (!commandVariablePattern.test(name) || typeof value !== "string")
        fail(
          "$.variables",
          "Variables require template names and string values",
        );
      variables.set(name, value);
    }
  }
  const plan = compileSteps(
    document.steps,
    "$.steps",
    { variables, allowReply: true },
    0,
  );
  if (!plan.steps.some(({ kind }) => kind === "send"))
    fail("$.steps", "The selected sequence must send at least one frame");
  return plan.steps;
}
