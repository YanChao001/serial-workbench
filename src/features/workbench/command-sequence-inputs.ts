import {
  commandSequenceMaxBytes,
  CommandSequenceError,
  compileCommandSequence,
  type CommandSequenceStep,
} from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-model";
import { commandVariablePattern } from "../../../packages/plugin-sdk/src/command-template";
import { isRecord } from "@/lib/settings-model";

const maxInputs = 32;

type SequenceDraft = {
  plan: readonly CommandSequenceStep[];
  inputs?: {
    names: readonly string[];
    paths: ReadonlyMap<string, string>;
    bind: (values: ReadonlyMap<string, string>) => string | undefined;
  };
};

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
    return { plan: compileCommandSequence(definition) };
  const entries = Object.entries(value.variables);
  const names = entries
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  if (!names.length) return { plan: compileCommandSequence(definition) };
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
    return { ...step, hex: "00" };
  });
  const usedNames = new Set(inputPaths.values());
  if (names.some((name) => !usedNames.has(name)))
    throw new CommandSequenceError(
      "$.variables",
      "Each input must be referenced by a full top-level send step",
    );
  const literalVariables = Object.fromEntries(
    entries.filter(([, value]) => value !== null),
  );
  const plan = compileCommandSequence(
    JSON.stringify({ ...value, steps, variables: literalVariables }),
  );
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
        const bound = JSON.stringify({
          ...value,
          variables: {
            ...literalVariables,
            ...Object.fromEntries(
              bindings.flatMap((entry) => (entry ? [entry] : [])),
            ),
          },
        });
        compileCommandSequence(bound);
        return bound;
      },
    },
  };
}
