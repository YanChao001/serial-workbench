import type {
  FileTransferParams,
  Operation,
  Target,
} from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { bytesToBase64 } from "@/lib/base64";
import {
  commandSequenceFrameBytes,
  commandSequenceMaxWriteWaitMs,
  CommandSequenceError,
} from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-model";
import { inspectSequenceDraft } from "./command-sequence-inputs";
import {
  confirmedFileWrite,
  parseRecordedFileStep,
  type FileReceiptReader,
  type RecordedFileStep,
} from "./recorded-file-step";
import { confirmedSessionWrite, matchesSend } from "./send-history-model";

const maxRecordedSends = 32;

type Step =
  | { kind: "send"; hex: string; writeWaitMs: number }
  | { kind: "delay"; milliseconds: number }
  | RecordedFileStep;
type Confirmed = { start: bigint; end: bigint; observedAt: number };
type Attempt = {
  submittedAt: number;
  evidence?: Confirmed | null;
} & (
  | { kind: "send"; bytes: Uint8Array; writeWaitMs: number }
  | { kind: "file"; step: RecordedFileStep }
);
type StopReason = "user" | "scope" | "unconfirmed" | "gap" | "limit";

function serialize(steps: readonly Step[], inputs: readonly string[]) {
  const variables = inputs.length
    ? Object.fromEntries(inputs.map((name) => [name, null]))
    : undefined;
  const version = steps.some(({ kind }) => kind === "file") ? 2 : 1;
  return JSON.stringify({ version, variables, steps }, null, 2);
}

export class ManualSendRecording {
  private readonly attempts: Attempt[] = [];
  private readonly steps: Step[] = [];
  private readonly inputs: string[] = [];
  private confirmed = 0;
  private previous?: Confirmed;
  private reason?: StopReason;
  private cut = false;

  constructor(
    readonly scope: string,
    private readonly target: Target,
    private readonly referenceBytes = false,
  ) {}

  add(bytes: Uint8Array, submittedAt: number, writeWaitMs: number) {
    if (this.reason) return;
    if (
      !bytes.length ||
      bytes.length > commandSequenceFrameBytes ||
      !Number.isInteger(writeWaitMs) ||
      writeWaitMs < 1 ||
      writeWaitMs > commandSequenceMaxWriteWaitMs
    ) {
      this.stop("limit");
      return;
    }
    return this.append({
      kind: "send",
      bytes: bytes.slice(),
      submittedAt,
      writeWaitMs,
    });
  }

  addFile(params: FileTransferParams, submittedAt: number) {
    if (this.reason) return;
    const {
      offset,
      length,
      chunkBytes,
      bytesPerSecond,
      interChunkMs,
      writeWaitMs,
    } = params;
    let step: RecordedFileStep;
    try {
      step = parseRecordedFileStep(
        {
          kind: "file",
          input: "recorded_file_" + (this.attempts.length + 1),
          offset,
          length,
          chunkBytes: chunkBytes ?? "4096",
          bytesPerSecond,
          interChunkMs,
          writeWaitMs,
        },
        "$.steps",
      );
    } catch (error) {
      if (!(error instanceof CommandSequenceError)) throw error;
      this.stop("limit");
      return;
    }
    return this.append({ kind: "file", step, submittedAt });
  }

  async settleFile(
    index: number,
    admitted: Operation | undefined,
    settled: Operation | undefined,
    read: FileReceiptReader,
    signal: AbortSignal,
    observedAt: number,
  ) {
    const attempt = this.attempts[index];
    if (
      this.cut ||
      attempt?.kind !== "file" ||
      attempt.evidence !== undefined ||
      signal.aborted
    )
      return;
    let range: { start: bigint; end: bigint } | undefined;
    try {
      if (admitted && settled)
        range = await confirmedFileWrite(
          admitted,
          settled,
          attempt.step,
          this.target,
          read,
          signal,
        );
    } catch {
      // Loss of access to the sealed journal ends the confirmed prefix.
    }
    if (this.cut || attempt.evidence !== undefined || signal.aborted) return;
    this.recordEvidence(attempt, range, observedAt);
  }

  private append(attempt: Attempt) {
    const index = this.attempts.push(attempt) - 1;
    if (this.attempts.length === maxRecordedSends) this.stop("limit");
    return index;
  }

  settle(
    index: number,
    admitted: Operation | undefined,
    settled: Operation | undefined,
    observedAt: number,
  ) {
    const attempt = this.attempts[index];
    if (this.cut || attempt?.kind !== "send" || attempt.evidence !== undefined)
      return;
    const range =
      admitted &&
      settled &&
      settled.operationId === admitted.operationId &&
      matchesSend(admitted, this.target)
        ? confirmedSessionWrite(
            settled,
            { bytes: attempt.bytes, bytesBase64: bytesToBase64(attempt.bytes) },
            this.target,
          )
        : undefined;
    this.recordEvidence(attempt, range, observedAt);
  }

  private recordEvidence(
    attempt: Attempt,
    range: { start: bigint; end: bigint } | undefined,
    observedAt: number,
  ) {
    attempt.evidence = range ? { ...range, observedAt } : null;
    this.advance();
  }

  stop(reason: "user" | "scope" | "limit") {
    this.reason ??= reason;
  }

  snapshot() {
    const ready =
      this.reason !== undefined &&
      (this.cut || this.confirmed === this.attempts.length);
    const phase = ready
      ? "ready"
      : this.reason !== undefined
        ? "settling"
        : "recording";
    return {
      phase,
      reason: this.reason,
      confirmed: this.confirmed,
      dirty: ready ? this.confirmed > 0 : this.attempts.length > 0,
      definition:
        ready && this.steps.length
          ? serialize(this.steps, this.inputs)
          : undefined,
    } as const;
  }

  private advance() {
    for (const attempt of this.attempts.slice(this.confirmed)) {
      const evidence = attempt.evidence;
      if (evidence === undefined) return;
      if (evidence === null) {
        this.endPrefix("unconfirmed");
        return;
      }
      if (this.previous && evidence.start !== this.previous.end) {
        this.endPrefix("gap");
        return;
      }
      const delay = this.previous
        ? Math.ceil(attempt.submittedAt - this.previous.observedAt)
        : 0;
      const recorded: Step[] = [];
      if (delay > 0) recorded.push({ kind: "delay", milliseconds: delay });
      const input =
        this.referenceBytes && attempt.kind === "send"
          ? "recorded_send_" + (this.confirmed + 1)
          : undefined;
      recorded.push(
        attempt.kind === "file"
          ? attempt.step
          : {
              kind: "send",
              hex: input ? "$" + "{" + input + "}" : formatHex(attempt.bytes),
              writeWaitMs: attempt.writeWaitMs,
            },
      );
      try {
        inspectSequenceDraft(
          serialize(
            [...this.steps, ...recorded],
            input ? [...this.inputs, input] : this.inputs,
          ),
        );
      } catch (error) {
        if (!(error instanceof CommandSequenceError)) throw error;
        this.endPrefix("limit");
        return;
      }
      this.steps.push(...recorded);
      if (input && attempt.kind === "send") {
        this.inputs.push(input);
        attempt.bytes.fill(0);
      }
      this.previous = evidence;
      this.confirmed++;
    }
  }

  private endPrefix(reason: "unconfirmed" | "gap" | "limit") {
    this.reason = reason;
    this.cut = true;
    if (this.referenceBytes)
      for (const attempt of this.attempts)
        if (attempt.kind === "send") attempt.bytes.fill(0);
  }
}
