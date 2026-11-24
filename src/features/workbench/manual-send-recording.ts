import type { Operation, Target } from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { bytesToBase64 } from "@/lib/base64";
import {
  CommandSequenceError,
  compileCommandSequence,
} from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-model";
import { repeatSendFrameBytes } from "./repeat-send-model";
import { confirmedSessionWrite, matchesSend } from "./send-history-model";

const maxRecordedSends = 32;

type Step =
  { kind: "send"; hex: string } | { kind: "delay"; milliseconds: number };
type Confirmed = { start: bigint; end: bigint; observedAt: number };
type Attempt = {
  bytes: Uint8Array;
  submittedAt: number;
  evidence?: Confirmed | null;
};
type StopReason = "user" | "scope" | "unconfirmed" | "gap" | "limit";

function serialize(steps: readonly Step[]) {
  return JSON.stringify({ version: 1, steps }, null, 2);
}

export class ManualSendRecording {
  private readonly attempts: Attempt[] = [];
  private readonly steps: Step[] = [];
  private confirmed = 0;
  private previous?: Confirmed;
  private reason?: StopReason;
  private cut = false;

  constructor(
    readonly scope: string,
    private readonly target: Target,
  ) {}

  add(bytes: Uint8Array, submittedAt: number) {
    if (this.reason) return;
    if (!bytes.length || bytes.length > repeatSendFrameBytes) {
      this.stop("limit");
      return;
    }
    const index = this.attempts.push({ bytes: bytes.slice(), submittedAt }) - 1;
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
    if (this.cut || !attempt || attempt.evidence !== undefined) return;
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
        ready && this.steps.length ? serialize(this.steps) : undefined,
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
      recorded.push({ kind: "send", hex: formatHex(attempt.bytes) });
      try {
        compileCommandSequence(serialize([...this.steps, ...recorded]));
      } catch (error) {
        if (!(error instanceof CommandSequenceError)) throw error;
        this.endPrefix("limit");
        return;
      }
      this.steps.push(...recorded);
      this.previous = evidence;
      this.confirmed++;
    }
  }

  private endPrefix(reason: "unconfirmed" | "gap" | "limit") {
    this.reason = reason;
    this.cut = true;
  }
}
