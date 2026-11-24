import type { Operation, Target } from "@serial-workbench/contracts";
import { expect, it } from "vitest";
import { bytesToBase64 } from "@/lib/base64";
import { ManualSendRecording } from "./manual-send-recording";
import { operation } from "./test-fixtures";

const target: Target = {
  hostId: "host",
  kind: "session",
  id: "session",
  sessionId: "session",
  sessionEpoch: "1",
};
const first = Uint8Array.of(0x00, 0xff);
const second = Uint8Array.of(0x42);

function tx(id: string): Operation {
  return { ...operation(id), actionId: "session.tx", target };
}

function receipt(id: string, bytes: Uint8Array, offset: number): Operation {
  return {
    ...tx(id),
    result: {
      kind: "tx",
      value: {
        operationId: id,
        sessionId: "session",
        sessionEpoch: "1",
        outcome: "accepted",
        bytesBase64: bytesToBase64(bytes),
        byteStart: String(offset),
        byteEnd: String(offset + bytes.length),
        acceptedRanges: [
          { start: String(offset), end: String(offset + bytes.length) },
        ],
        unknownRanges: [],
        peerAcknowledged: false,
      },
    },
  };
}

function draft(recording: ManualSendRecording): unknown {
  const { definition } = recording.snapshot();
  return definition === undefined ? undefined : JSON.parse(definition);
}

it("settles a stopped recording in user order even when receipt observations arrive out of order", () => {
  const recording = new ManualSendRecording("scope", target);
  const one = recording.add(first, 10)!;
  const two = recording.add(second, 49.5)!;
  recording.stop("user");

  recording.settle(two, tx("two"), receipt("two", second, 52), 51);
  expect(recording.snapshot()).toMatchObject({
    phase: "settling",
    confirmed: 0,
  });
  recording.settle(one, tx("one"), receipt("one", first, 50), 24);
  expect(recording.snapshot()).toMatchObject({ phase: "ready", confirmed: 2 });
  expect(draft(recording)).toEqual({
    version: 1,
    steps: [
      { kind: "send", hex: "00 FF" },
      { kind: "delay", milliseconds: 26 },
      { kind: "send", hex: "42" },
    ],
  });
  expect(recording.add(second, 70)).toBeUndefined();
});

it.each(["missing", "unrelated", "gap"] as const)(
  "keeps only the confirmed prefix when the second write has %s evidence",
  (kind) => {
    const recording = new ManualSendRecording("scope", target);
    const one = recording.add(first, 10)!;
    const two = recording.add(second, 20)!;
    const three = recording.add(second, 30)!;
    recording.settle(three, tx("three"), receipt("three", second, 53), 39);
    recording.settle(one, tx("one"), receipt("one", first, 50), 41);
    const proof =
      kind === "missing"
        ? undefined
        : receipt(kind === "unrelated" ? "wrong" : "two", second, 54);
    recording.settle(two, tx("two"), proof, 42);
    expect(recording.snapshot()).toMatchObject({
      phase: "ready",
      reason: kind === "gap" ? "gap" : "unconfirmed",
      confirmed: 1,
    });
    expect(draft(recording)).toEqual({
      version: 1,
      steps: [{ kind: "send", hex: "00 FF" }],
    });
  },
);

it("keeps confirmed work on scope change and omits an interval outside sequence limits", () => {
  const recording = new ManualSendRecording("scope", target);
  const one = recording.add(first, 1)!;
  const two = recording.add(second, 65_000)!;
  recording.settle(one, tx("one"), receipt("one", first, 50), 2);
  recording.stop("scope");
  expect(recording.add(second, 65_001)).toBeUndefined();
  recording.settle(two, tx("two"), receipt("two", second, 52), 65_010);
  expect(recording.snapshot()).toMatchObject({
    phase: "ready",
    reason: "limit",
    confirmed: 1,
  });
});
