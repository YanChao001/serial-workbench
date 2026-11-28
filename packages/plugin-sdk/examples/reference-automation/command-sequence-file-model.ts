import type {
  FileTransferParams,
  ObjectRef,
} from "@serial-workbench/contracts";
import { commandVariablePattern } from "../../src/command-template.ts";
import {
  commandSequenceMaxBytes,
  CommandSequenceError,
  compileCommandSequence,
  type CommandSequenceStep,
} from "./command-sequence-model.ts";

const U64_MAX = 18_446_744_073_709_551_615n;

function parseU64(value: unknown) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value))
    return;
  const number = BigInt(value);
  return number <= U64_MAX ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type RecordedRange = Required<Omit<FileTransferParams, "sourceRef">>;
export type RecordedFileStep = RecordedRange & { kind: "file"; input: string };
type FilePlanStep = RecordedFileStep & { path: string };
export type PortableSequenceStep = CommandSequenceStep | FilePlanStep;

const rangeKeys = [
  "offset",
  "length",
  "chunkBytes",
  "bytesPerSecond",
  "interChunkMs",
  "writeWaitMs",
] as const satisfies readonly (keyof RecordedRange)[];

export function recordedFileBounds(step: RecordedFileStep) {
  const offset = parseU64(step.offset);
  const length = parseU64(step.length);
  const chunk = parseU64(step.chunkBytes);
  const rate = parseU64(step.bytesPerSecond);
  const interval = parseU64(step.interChunkMs);
  const wait = parseU64(step.writeWaitMs);
  if (
    offset === undefined ||
    !length ||
    offset + length > U64_MAX ||
    !chunk ||
    chunk > 16_384n ||
    !rate ||
    rate > 16_777_216n ||
    interval === undefined ||
    interval > 2_147_483_647n ||
    !wait
  )
    return;
  return { offset, length, chunk };
}

export function parseRecordedFileStep(
  value: unknown,
  path: string,
): RecordedFileStep {
  if (
    !isRecord(value) ||
    value.kind !== "file" ||
    typeof value.input !== "string" ||
    !commandVariablePattern.test(value.input)
  )
    throw new CommandSequenceError(path, "Expected a named file input");
  const {
    offset,
    length,
    chunkBytes,
    bytesPerSecond,
    interChunkMs,
    writeWaitMs,
  } = value;
  if (
    typeof offset !== "string" ||
    typeof length !== "string" ||
    typeof chunkBytes !== "string" ||
    typeof bytesPerSecond !== "string" ||
    typeof interChunkMs !== "string" ||
    typeof writeWaitMs !== "string" ||
    Object.keys(value).some(
      (key) =>
        key !== "kind" &&
        key !== "input" &&
        !rangeKeys.some((option) => option === key),
    )
  )
    throw new CommandSequenceError(
      path,
      "Expected only the file input and send options",
    );
  const step: RecordedFileStep = {
    kind: "file",
    input: value.input,
    offset,
    length,
    chunkBytes,
    bytesPerSecond,
    interChunkMs,
    writeWaitMs,
  };
  if (!recordedFileBounds(step))
    throw new CommandSequenceError(path, "Invalid file range or pacing");
  return step;
}

export function compilePortableSequence(
  definition: unknown,
): PortableSequenceStep[] {
  if (
    typeof definition !== "string" ||
    definition.length > commandSequenceMaxBytes ||
    new TextEncoder().encode(definition).length > commandSequenceMaxBytes
  )
    throw new CommandSequenceError(
      "$",
      "Expected a bounded UTF-8 JSON definition",
    );
  let value: unknown;
  try {
    value = JSON.parse(definition);
  } catch {
    throw new CommandSequenceError("$", "Invalid JSON definition");
  }
  if (!isRecord(value) || value.version !== 2)
    return compileCommandSequence(definition);
  if (!Array.isArray(value.steps) || value.steps.length > 64)
    throw new CommandSequenceError("$.steps", "Expected a bounded step list");
  const files = new Map<string, FilePlanStep>();
  const steps = value.steps.map((step: unknown, index) => {
    if (!isRecord(step) || step.kind !== "file") return step;
    const path = "$.steps[" + index + "]";
    files.set(path, { ...parseRecordedFileStep(step, path), path });
    // Use the existing step budget and branch compiler. File placeholders are
    // replaced by their typed steps before the plan can reach an executor.
    return { kind: "send", hex: "00" };
  });
  if (
    !files.size ||
    new Set(Array.from(files.values(), ({ input }) => input)).size > 32
  )
    throw new CommandSequenceError(
      "$.steps",
      "Version 2 requires one to 32 file inputs",
    );
  const plan = compileCommandSequence(
    JSON.stringify({ ...value, version: 1, steps }),
  );
  return plan.map((step) => files.get(step.path) ?? step);
}

export function resolveSequenceFiles(
  plan: readonly PortableSequenceStep[],
  bindings: unknown,
  hostId: string,
) {
  const required = new Set(
    plan.flatMap((step) => (step.kind === "file" ? [step.input] : [])),
  );
  const files = new Map<string, ObjectRef>();
  if (required.size === 0 && bindings === undefined) return files;
  if (!Array.isArray(bindings) || bindings.length !== required.size)
    throw new CommandSequenceError(
      "$.fileBindings",
      "Bind each required file input exactly once",
    );
  for (const entry of bindings as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.input !== "string" ||
      !required.has(entry.input) ||
      files.has(entry.input) ||
      Object.keys(entry).length !== 2 ||
      !isRecord(entry.sourceRef)
    )
      throw new CommandSequenceError("$.fileBindings", "Invalid file binding");
    const { id, revision, kind } = entry.sourceRef;
    if (
      kind !== "file" ||
      entry.sourceRef.hostId !== hostId ||
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 128 ||
      typeof revision !== "string" ||
      !parseU64(revision) ||
      Object.keys(entry.sourceRef).length !== 4
    )
      throw new CommandSequenceError(
        "$.fileBindings",
        "Expected a fixed file on the target Host",
      );
    files.set(entry.input, { hostId, kind, id, revision });
  }
  return files;
}
