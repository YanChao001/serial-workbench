import { expect, test } from "vitest";
import type { RawEvent, StreamItem, Target } from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { compileProtocolFields } from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import {
  inspectFraming,
  type FramingInspection,
} from "./framing-anomalies-model";

const target: Target = {
  kind: "session",
  id: "session",
  hostId: "host",
  sessionId: "session",
  sessionEpoch: "1",
};
function rx(
  index: number,
  start: number,
  bytes: readonly number[],
  ms: number,
): RawEvent {
  return {
    hostId: target.hostId,
    instanceEpoch: "1",
    sessionId: target.id,
    sessionEpoch: "1",
    eventSeq: String(index),
    configurationRevision: "1",
    time: {
      sourceMonoNs: String(9007199254740993n + BigInt(ms) * 1_000_000n),
      clockId: "peer-clock",
      receivedWallTime: "2026-11-08T00:00:00Z",
      precision: { source: "host_read", resolutionNs: "1", syncMethod: "none" },
    },
    kind: "rx",
    payload: {
      bytesBase64: btoa(String.fromCharCode(...bytes)),
      byteStart: String(start),
      byteEnd: String(start + bytes.length),
    },
  };
}

function fixture(
  samples: { bytes: number[]; ms: number }[],
): FramingInspection {
  let position = 0;
  const items: StreamItem[] = [];
  const frames = samples.map(({ bytes, ms }, offset) => {
    const event = rx(offset + 1, position, bytes, ms);
    items.push({ kind: "source", event });
    const frame = {
      hex: formatHex(Uint8Array.from(bytes)),
      eventStart: event.eventSeq,
      eventEnd: String(offset + 2),
      byteStart: String(position),
      byteEnd: String(position + bytes.length),
    };
    position += bytes.length;
    return frame;
  });
  return { target, items, frames };
}

const codec = compileProtocolFields({
  version: "1",
  byteLength: 3,
  fields: [
    { id: "seq", kind: "integer", byteOffset: 0, width: 1, order: "big" },
    {
      id: "sum",
      kind: "checksum",
      algorithm: "sum",
      byteOffset: 2,
      coverageStart: 0,
      coverageEnd: 2,
      order: "big",
    },
  ],
});
const rules = {
  sequenceField: "seq",
  missingLimit: 8n,
  timeoutNs: 5_000_000n,
  repeatBytes: false,
};
const normal = (seq: number, ms: number) => ({
  bytes: [seq, 1, (seq + 1) & 255],
  ms,
});

test("framing inspection reports a wrap, loss, duplicates, jumps, corrupted checksums and length independently", () => {
  const input = fixture([
    normal(254, 0),
    normal(255, 1),
    normal(0, 2),
    normal(3, 20),
    normal(3, 21),
    normal(249, 22),
    { bytes: [250, 1, 0], ms: 23 },
    { bytes: [251, 1], ms: 24 },
  ]);
  const report = inspectFraming(input, codec, rules);
  expect(report.frames).toBe(8);
  expect(report.unavailableTransitions).toBe(0);
  expect(report.findings).toMatchObject([
    {
      kind: "timeout",
      elapsedNs: 18_000_000n,
      clock: "peer-clock",
      lastEvent: 4n,
      frame: input.frames[3],
    },
    {
      kind: "missing",
      expected: "1",
      actual: "3",
      count: "2",
      frame: input.frames[3],
    },
    { kind: "duplicate", sequence: "3" },
    { kind: "sequence_jump", expected: "4", actual: "249" },
    { kind: "checksum", field: "sum", actual: "00", expected: "FB" },
    { kind: "length", length: 2, expected: 3 },
  ]);
});

test("the previous page participates only while every retained event proves continuity", () => {
  const input = fixture([normal(1, 0), normal(2, 1), normal(5, 40)]);
  const afterBoundary = {
    ...input,
    previous: input.frames[1],
    frames: input.frames.slice(2),
  };
  expect(inspectFraming(afterBoundary, codec, rules).findings).toMatchObject([
    { kind: "timeout", elapsedNs: 39_000_000n },
    { kind: "missing", count: "2" },
  ]);
  const missing = {
    ...afterBoundary,
    items: [input.items[0]!, input.items[2]!],
  };
  expect(inspectFraming(missing, codec, rules)).toMatchObject({
    findings: [],
    unavailableTransitions: 1,
  });
  const later = input.items[2];
  if (later?.kind !== "source") throw new Error("Expected Raw source");
  const reconfigured: StreamItem = {
    ...later,
    event: { ...later.event, configurationRevision: "2" },
  };
  expect(
    inspectFraming(
      { ...afterBoundary, items: [...input.items.slice(0, 2), reconfigured] },
      codec,
      rules,
    ),
  ).toMatchObject({ findings: [], unavailableTransitions: 1 });
});

test("a trailing timeout requires a later event in the configured observation window", () => {
  const input = fixture([normal(5, 0), normal(5, 1)]);
  const later: StreamItem = { kind: "source", event: rx(3, 6, [10], 20) };
  const settings = { ...rules, sequenceField: undefined, repeatBytes: true };
  expect(
    inspectFraming(
      { ...input, items: [...input.items, later], endEventSeq: "4" },
      undefined,
      settings,
    ).findings,
  ).toMatchObject([
    { kind: "duplicate" },
    { kind: "timeout", tail: true, lastEvent: 3n, elapsedNs: 19_000_000n },
  ]);
  expect(
    inspectFraming({ ...input, endEventSeq: "4" }, undefined, settings),
  ).toMatchObject({
    findings: [{ kind: "duplicate" }],
    unavailableTransitions: 1,
  });
});
