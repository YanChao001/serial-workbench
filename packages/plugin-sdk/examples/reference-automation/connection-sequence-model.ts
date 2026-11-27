import type { SerialConfiguration } from "@serial-workbench/contracts";

export const builtinConnectionSequenceAction = "swb.builtin.automation.connect";
export const connectionSequenceMaximumSteps = 16;
const maximumFrameBytes = 256;
const maximumPreopenMs = 30_000;
const maximumStepWaitMs = 15_000;
const maximumStepWaitTotalMs = 24_000;

export type ConnectionSequenceStep =
  | { kind: "line"; line: "dtr" | "rts"; value: boolean }
  | { kind: "delay"; milliseconds: number }
  | { kind: "send"; bytesBase64: string }
  | { kind: "ready"; bytesBase64: string; timeoutMs: number };

export type ConnectionSequence = {
  version: 1;
  beforeOpenMs: number;
  steps: ConnectionSequenceStep[];
};

function invalid(path: string): never {
  throw new Error(`Invalid connection sequence at ${path}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid(path);
  return value as Record<string, unknown>;
}

function checkKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
) {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid(path);
}

function duration(value: unknown, min: number, max: number, path: string) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    return invalid(path);
  return value;
}

function frame(value: unknown, path: string) {
  if (typeof value !== "string" || value.length < 4 || value.length > 344)
    return invalid(path);
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    return invalid(path);
  }
  if (decoded.length > maximumFrameBytes || btoa(decoded) !== value)
    return invalid(path);
  return value;
}

export function compileConnectionSequence(
  value: unknown,
  flowControl: SerialConfiguration["flowControl"],
): ConnectionSequence {
  const input = object(value, "definition");
  checkKeys(input, ["version", "beforeOpenMs", "steps"], "definition");
  if (input.version !== 1) invalid("version");
  const beforeOpenMs = duration(
    input.beforeOpenMs,
    0,
    maximumPreopenMs,
    "beforeOpenMs",
  );
  if (
    !Array.isArray(input.steps) ||
    input.steps.length > connectionSequenceMaximumSteps ||
    (input.steps.length === 0 && beforeOpenMs === 0)
  )
    return invalid("steps");

  let totalWaitMs = 0;
  const steps = input.steps.map(
    (raw: unknown, index): ConnectionSequenceStep => {
      const path = `steps[${index}]`;
      const step = object(raw, path);
      switch (step.kind) {
        case "line": {
          checkKeys(step, ["kind", "line", "value"], path);
          const { line, value } = step;
          if (
            (line !== "dtr" && line !== "rts") ||
            typeof value !== "boolean" ||
            (line === "dtr" && flowControl === "dsrDtr") ||
            (line === "rts" && flowControl === "rtsCts")
          )
            return invalid(path);
          return { kind: "line", line, value };
        }
        case "delay": {
          checkKeys(step, ["kind", "milliseconds"], path);
          const milliseconds = duration(
            step.milliseconds,
            1,
            maximumStepWaitMs,
            `${path}.milliseconds`,
          );
          totalWaitMs += milliseconds;
          return { kind: "delay", milliseconds };
        }
        case "send":
          checkKeys(step, ["kind", "bytesBase64"], path);
          return {
            kind: "send",
            bytesBase64: frame(step.bytesBase64, `${path}.bytesBase64`),
          };
        case "ready": {
          checkKeys(step, ["kind", "bytesBase64", "timeoutMs"], path);
          const timeoutMs = duration(
            step.timeoutMs,
            1,
            maximumStepWaitMs,
            `${path}.timeoutMs`,
          );
          totalWaitMs += timeoutMs;
          return {
            kind: "ready",
            bytesBase64: frame(step.bytesBase64, `${path}.bytesBase64`),
            timeoutMs,
          };
        }
        default:
          return invalid(path);
      }
    },
  );
  if (totalWaitMs > maximumStepWaitTotalMs) invalid("steps");
  return { version: 1, beforeOpenMs, steps };
}
