import {
  commandSequenceFrameBytes,
  commandSequenceMaxBytes,
  CommandSequenceError,
  compileCommandSequence,
  type CommandSequenceStep,
} from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-model";
import {
  commandVariablePattern,
  expandCommandTemplate,
  parseCommandTemplate,
} from "../../../packages/plugin-sdk/src/command-template";
import { parseHex } from "../../../packages/plugin-sdk/src/hex";
import { isRecord } from "@/lib/settings-model";
import {
  parseRecordedFileStep,
  type RecordedFileStep,
} from "./recorded-file-step";

const maxInputs = 32;

type FilePreviewStep = RecordedFileStep & { path: string };
export type SequencePreviewStep = CommandSequenceStep | FilePreviewStep;
type SequenceDraft = {
  plan: readonly SequencePreviewStep[];
  inputs?: {
    names: readonly string[];
    paths: ReadonlyMap<string, string>;
    bind: (values: ReadonlyMap<string, string>) => string | undefined;
  };
};

function previewFrame(
  expectation: unknown,
  variables: ReadonlyMap<string, string>,
) {
  if (!isRecord(expectation) || !Array.isArray(expectation.retry)) return "00";
  const retries: readonly unknown[] = expectation.retry;
  const retryBytes = new Set<number>();
  const maxHexText = commandSequenceFrameBytes * 4;
  for (const retry of retries) {
    if (
      !isRecord(retry) ||
      typeof retry.hex !== "string" ||
      retry.hex.length > maxHexText
    )
      continue;
    const expanded = expandCommandTemplate(
      parseCommandTemplate(retry.hex).parts,
      variables,
      maxHexText,
    );
    if (expanded.kind !== "ready") continue;
    try {
      const bytes = parseHex(expanded.body);
      if (bytes.length === 1) retryBytes.add(bytes[0]!);
    } catch {
      // The compiler will report an invalid retry frame at its original path.
    }
  }
  // A valid sequence has at most three retries, leaving a one-byte preview frame.
  const byte = [0, 1, 2, 3].find((byte) => !retryBytes.has(byte)) ?? 0;
  return byte.toString(16).padStart(2, "0");
}

function compilePreview(
  value: unknown,
  definition: string,
): SequencePreviewStep[] {
  if (!isRecord(value) || value.version !== 2)
    return compileCommandSequence(definition);
  if (!Array.isArray(value.steps))
    throw new CommandSequenceError("$.steps", "Expected sequence steps");
  const files = new Map<string, FilePreviewStep>();
  const steps = value.steps.map((step: unknown, index) => {
    if (!isRecord(step) || step.kind !== "file") return step;
    const path = "$.steps[" + index + "]";
    files.set(path, { ...parseRecordedFileStep(step, path), path });
    // Count the file in the version 1 step budget. The projected plan restores the original file.
    return { kind: "send", hex: "00" };
  });
  const validated = compileCommandSequence(
    JSON.stringify({ ...value, version: 1, steps }),
  );
  if (!files.size)
    throw new CommandSequenceError(
      "$.steps",
      "Version 2 requires a file input",
    );
  return validated.map((step) => files.get(step.path) ?? step);
}

export function inspectSequenceDraft(definition: string): SequenceDraft {
  if (
    definition.length > commandSequenceMaxBytes ||
    new TextEncoder().encode(definition).length > commandSequenceMaxBytes
  ) {
    throw new CommandSequenceError(
      "$",
      "Expected a bounded UTF-8 JSON definition",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(definition);
  } catch {
    throw new CommandSequenceError("$", "Invalid JSON definition");
  }
  if (!isRecord(value) || !isRecord(value.variables))
    return { plan: compilePreview(value, definition) };
  const entries = Object.entries(value.variables);
  const names = entries
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  if (!names.length) return { plan: compilePreview(value, definition) };
  if (
    names.length > maxInputs ||
    names.some((name) => !commandVariablePattern.test(name))
  )
    throw new CommandSequenceError(
      "$.variables",
      "Expected at most 32 valid input names",
    );
  if (!Array.isArray(value.steps))
    throw new CommandSequenceError("$.steps", "Expected sequence steps");

  const literalEntries = entries.filter(([, value]) => value !== null);
  const literalVariables = Object.fromEntries(literalEntries);
  const literalValues = new Map(
    literalEntries.filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const inputPaths = new Map<string, string>();
  const placeholders = new Map(
    names.map((name) => ["$" + "{" + name + "}", name]),
  );
  const steps = value.steps.map((step: unknown, index) => {
    if (!isRecord(step) || step.kind !== "send" || typeof step.hex !== "string")
      return step;
    const name = placeholders.get(step.hex);
    if (!name) return step;
    inputPaths.set("$.steps[" + index + "]", name);
    return { ...step, hex: previewFrame(step.expect, literalValues) };
  });
  const usedNames = new Set(inputPaths.values());
  if (names.some((name) => !usedNames.has(name)))
    throw new CommandSequenceError(
      "$.variables",
      "Each input must be referenced by a full top-level send step",
    );
  const preview = { ...value, steps, variables: literalVariables };
  const plan = compilePreview(preview, JSON.stringify(preview));
  return {
    plan,
    inputs: {
      names,
      paths: inputPaths,
      bind(values: ReadonlyMap<string, string>) {
        const bindings = names.map((name) => {
          const value = values.get(name);
          if (!value?.trim()) return;
          return [name, value] as const;
        });
        if (bindings.some((entry) => entry === undefined)) return;
        const bound = {
          ...value,
          variables: {
            ...literalVariables,
            ...Object.fromEntries(
              bindings.flatMap((entry) => (entry ? [entry] : [])),
            ),
          },
        };
        const serialized = JSON.stringify(bound);
        compilePreview(bound, serialized);
        return serialized;
      },
    },
  };
}
