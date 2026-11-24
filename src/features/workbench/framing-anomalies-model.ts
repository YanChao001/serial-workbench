import type { RawEvent, StreamItem, Target } from "@serial-workbench/contracts";
import { parseHex } from "@serial-workbench/host-client";
import { parseU64 } from "@/lib/u64";
import {
  ProtocolFieldError,
  type compileProtocolFields,
} from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import type { FramingFrame } from "./framing-model";

type Codec = ReturnType<typeof compileProtocolFields>;
type Point = { clock: string; ns: bigint; instance: string; revision: string };
type Evidence = {
  frame: FramingFrame;
  first: bigint;
  last: bigint;
  time?: Point;
  sequence?: { value: bigint; modulus: bigint };
  valid: boolean;
};

export type FramingInspection = {
  target: Target;
  items: readonly StreamItem[];
  frames: readonly FramingFrame[];
  previous?: FramingFrame;
  endEventSeq?: string;
};

export type AnomalyRules = {
  timeoutNs?: bigint;
  sequenceField?: string;
  missingLimit: bigint;
  repeatBytes: boolean;
};

type FindingDetail =
  | { kind: "length"; length: number; expected: number }
  | { kind: "checksum"; field: string; actual: string; expected: string }
  | { kind: "decode"; path: string }
  | { kind: "duplicate"; sequence?: string }
  | { kind: "missing"; expected: string; actual: string; count: string }
  | { kind: "sequence_jump"; expected: string; actual: string }
  | {
      kind: "timeout";
      elapsedNs: bigint;
      clock: string;
      lastEvent: bigint;
      tail?: true;
    };
export type FramingFinding = FindingDetail & { frame: FramingFrame };

function eventPoint(event: RawEvent | undefined): Point | undefined {
  if (!event) return;
  const ns = parseU64(event.time.sourceMonoNs);
  if (ns !== undefined)
    return {
      clock: event.time.clockId,
      ns,
      instance: event.instanceEpoch,
      revision: event.configurationRevision,
    };
}

function eventRun(events: Map<bigint, RawEvent>, from: bigint, to: bigint) {
  if (to < from || to - from >= 1024n) return false;
  const start = eventPoint(events.get(from));
  if (!start) return false;
  let last = start;
  for (let seq = from; seq <= to; seq++) {
    const event = events.get(seq);
    const timestamp = eventPoint(event);
    if (
      !event ||
      event.kind === "gap" ||
      event.kind === "configuration_boundary" ||
      event.kind === "lifecycle" ||
      !timestamp ||
      timestamp.clock !== last.clock ||
      timestamp.instance !== last.instance ||
      timestamp.revision !== last.revision ||
      timestamp.ns < last.ns
    )
      return false;
    last = timestamp;
  }
  return true;
}

function sequenceFrom(
  reading: ReturnType<Codec["decode"]>[number] | undefined,
) {
  if (
    !reading ||
    (reading.kind !== "integer" && reading.kind !== "bits") ||
    reading.rawValue === undefined
  )
    return undefined;
  const width = reading.bits
    ? reading.bits.end - reading.bits.start
    : (reading.bytes.end - reading.bytes.start) * 8;
  return {
    value: BigInt.asUintN(width, BigInt(reading.rawValue)),
    modulus: 1n << BigInt(width),
  };
}

export function inspectFraming(
  inspection: FramingInspection,
  codec: Codec | undefined,
  rules: AnomalyRules,
) {
  const { frames, previous, items, target, endEventSeq } = inspection;
  const events = new Map<bigint, RawEvent>();
  const firstFrame = previous ?? frames[0];
  const lastFrame = frames.at(-1) ?? previous;
  const firstSeq = parseU64(firstFrame?.eventStart);
  const endSeq = parseU64(endEventSeq ?? lastFrame?.eventEnd);
  if (firstSeq !== undefined && endSeq !== undefined) {
    for (const item of items) {
      if (item.kind !== "source") continue;
      const event = item.event;
      const seq = parseU64(event.eventSeq);
      if (
        seq !== undefined &&
        seq >= firstSeq &&
        seq < endSeq &&
        event.hostId === target.hostId &&
        event.sessionId === target.sessionId &&
        event.sessionEpoch === target.sessionEpoch
      )
        events.set(seq, event);
    }
  }
  const findings: FramingFinding[] = [];
  let unavailableTransitions = 0;
  function inspect(frame: FramingFrame, report: boolean): Evidence {
    const first = BigInt(frame.eventStart);
    const last = BigInt(frame.eventEnd) - 1n;
    const firstEvent = events.get(first);
    const lastEvent = events.get(last);
    const time =
      firstEvent?.kind === "rx" &&
      lastEvent?.kind === "rx" &&
      eventRun(events, first, last)
        ? eventPoint(lastEvent)
        : undefined;
    const bytes = parseHex(frame.hex);
    const evidence: Evidence = { frame, first, last, time, valid: false };
    if (!codec) return { ...evidence, valid: true };
    if (bytes.length !== codec.byteLength) {
      if (report)
        findings.push({
          kind: "length",
          frame,
          length: bytes.length,
          expected: codec.byteLength,
        });
      return evidence;
    }
    try {
      const readings = codec.decode(bytes);
      const failed = readings.filter(
        (reading) => reading.checksum?.valid === false,
      );
      if (report) {
        for (const reading of failed)
          findings.push({
            kind: "checksum",
            frame,
            field: reading.id,
            actual: reading.rawHex,
            expected: reading.checksum!.expectedHex,
          });
      }
      evidence.valid = failed.length === 0;
      evidence.sequence =
        rules.sequenceField === undefined
          ? undefined
          : sequenceFrom(readings.find(({ id }) => id === rules.sequenceField));
    } catch (reason) {
      if (!(reason instanceof ProtocolFieldError)) throw reason;
      if (report) findings.push({ kind: "decode", frame, path: reason.path });
    }
    return evidence;
  }

  function checkTimeout(
    start: Evidence,
    end: Point,
    lastEvent: bigint,
    frame: FramingFrame,
    tail?: true,
  ) {
    if (
      !start.time ||
      start.time.clock !== end.clock ||
      rules.timeoutNs === undefined
    )
      return;
    const elapsedNs = end.ns - start.time.ns;
    if (elapsedNs > rules.timeoutNs)
      findings.push({
        kind: "timeout",
        frame,
        elapsedNs,
        clock: end.clock,
        lastEvent,
        tail,
      });
  }

  function compare(before: Evidence, current: Evidence) {
    if (
      rules.timeoutNs === undefined &&
      !rules.sequenceField &&
      !rules.repeatBytes
    )
      return;
    const { frame } = current;
    if (
      !before.time ||
      !current.time ||
      before.frame.byteEnd !== frame.byteStart ||
      !eventRun(events, before.last, current.first)
    ) {
      unavailableTransitions++;
      return;
    }
    checkTimeout(before, current.time, current.last, frame);
    if (!before.valid || !current.valid) return;
    const prior = before.sequence;
    const next = current.sequence;
    if (prior && next && prior.modulus === next.modulus) {
      const { modulus } = prior;
      const distance = (next.value - prior.value + modulus) % modulus;
      const expected = String((prior.value + 1n) % modulus);
      const actual = String(next.value);
      if (distance === 0n)
        findings.push({ kind: "duplicate", frame, sequence: actual });
      else if (distance > 1n) {
        const count = distance - 1n;
        if (distance * 2n < modulus && count <= rules.missingLimit)
          findings.push({
            kind: "missing",
            frame,
            expected,
            actual,
            count: String(count),
          });
        else findings.push({ kind: "sequence_jump", frame, expected, actual });
      }
    } else if (rules.repeatBytes && before.frame.hex === frame.hex) {
      findings.push({ kind: "duplicate", frame });
    }
  }

  let prior = previous && inspect(previous, false);
  for (const frame of frames) {
    const current = inspect(frame, true);
    if (prior) compare(prior, current);
    prior = current;
  }
  const end = parseU64(endEventSeq);
  if (
    prior &&
    end !== undefined &&
    end > prior.last + 1n &&
    rules.timeoutNs !== undefined
  ) {
    const lastEvent = end - 1n;
    const event = eventPoint(events.get(lastEvent));
    if (prior.time && event && eventRun(events, prior.last, lastEvent))
      checkTimeout(prior, event, lastEvent, prior.frame, true);
    else unavailableTransitions++;
  }
  return { findings, frames: frames.length, unavailableTransitions };
}
