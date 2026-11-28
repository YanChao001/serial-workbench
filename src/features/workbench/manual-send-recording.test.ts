import type {
  FileTransferParams,
  FileTransferReceiptsParams,
  FileTransferReceiptsResult,
  Operation,
  Target,
} from "@serial-workbench/contracts";
import { expect, it } from "vitest";
import { bytesToBase64 } from "@/lib/base64";
import { inspectSequenceDraft } from "./command-sequence-inputs";
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
        acceptedRanges: [{ start: "0", end: String(bytes.length) }],
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
  const one = recording.add(first, 10, 3200)!;
  const two = recording.add(second, 49.5, 1010)!;
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
      { kind: "send", hex: "00 FF", writeWaitMs: 3200 },
      { kind: "delay", milliseconds: 26 },
      { kind: "send", hex: "42", writeWaitMs: 1010 },
    ],
  });
  expect(recording.add(second, 70, 1000)).toBeUndefined();
});

it.each(["missing", "unrelated", "gap"] as const)(
  "keeps only the confirmed prefix when the second write has %s evidence",
  (kind) => {
    const recording = new ManualSendRecording("scope", target);
    const one = recording.add(first, 10, 1000)!;
    const two = recording.add(second, 20, 1000)!;
    const three = recording.add(second, 30, 1000)!;
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
      steps: [{ kind: "send", hex: "00 FF", writeWaitMs: 1000 }],
    });
  },
);

it("keeps confirmed work on scope change and omits an interval outside sequence limits", () => {
  const recording = new ManualSendRecording("scope", target);
  const one = recording.add(first, 1, 1000)!;
  const two = recording.add(second, 65_000, 1000)!;
  recording.settle(one, tx("one"), receipt("one", first, 50), 2);
  recording.stop("scope");
  expect(recording.add(second, 65_001, 1000)).toBeUndefined();
  recording.settle(two, tx("two"), receipt("two", second, 52), 65_010);
  expect(recording.snapshot()).toMatchObject({
    phase: "ready",
    reason: "limit",
    confirmed: 1,
  });
});

it("describes a complete long file by a slot and confirms only the sealed edge receipts", async () => {
  const recording = new ManualSendRecording("scope", target, true);
  const sourceRef = {
    hostId: "host",
    kind: "file",
    id: "temporary-source",
    revision: "4",
  };
  const params: FileTransferParams = {
    sourceRef,
    offset: "1",
    length: "768",
    chunkBytes: "256",
    bytesPerSecond: "1048576",
    interChunkMs: "2",
    writeWaitMs: "2000",
  };
  const admitted: Operation = {
    ...operation("file-tx"),
    target,
    actionId: "transfer.file",
  };
  const receiptsRef = {
    hostId: "host",
    kind: "transfer_receipts",
    id: "file-tx",
    revision: "1",
  };
  const settled: Operation = {
    ...admitted,
    result: {
      kind: "file_transfer",
      value: {
        receiptsRef,
        requested: "768",
        accepted: "768",
        unknown: "0",
        peerAcknowledged: false,
      },
    },
  };
  const ordinals: string[] = [];
  let interleaved = false;
  const read = async (
    request: FileTransferReceiptsParams,
  ): Promise<FileTransferReceiptsResult> => {
    expect(request.receiptsRef).toEqual(receiptsRef);
    expect(request.maxReceipts).toBe("1");
    const ordinal = request.startOrdinal;
    expect(["0", "2"]).toContain(ordinal);
    ordinals.push(ordinal);
    const first = ordinal === "0";
    const start = first ? 52 : interleaved ? 565 : 564;
    return {
      receiptsRef,
      sealed: true,
      count: "3",
      nextOrdinal: first ? "1" : "3",
      hasMore: first,
      receipts: [
        {
          sourceOffset: first ? "1" : "513",
          receipt: {
            operationId: admitted.operationId,
            sessionId: "session",
            sessionEpoch: "1",
            outcome: "accepted",
            bytesBase64: bytesToBase64(new Uint8Array(256)),
            byteStart: String(start),
            byteEnd: String(start + 256),
            acceptedRanges: [{ start: "0", end: "256" }],
            unknownRanges: [],
            peerAcknowledged: false,
          },
        },
      ],
    };
  };
  const send = recording.add(first, 10, 2000)!;
  const file = recording.addFile(params, 50)!;
  recording.stop("user");
  await recording.settleFile(
    file,
    admitted,
    settled,
    read,
    new AbortController().signal,
    80,
  );
  expect(recording.snapshot()).toMatchObject({
    phase: "settling",
    confirmed: 0,
  });
  recording.settle(send, tx("first"), receipt("first", first, 50), 20);
  expect(ordinals.sort()).toEqual(["0", "2"]);
  const definition = recording.snapshot().definition!;
  expect(definition).not.toContain(sourceRef.id);
  expect(JSON.parse(definition)).toEqual({
    version: 2,
    variables: { recorded_send_1: null },
    steps: [
      { kind: "send", hex: "$" + "{recorded_send_1}", writeWaitMs: 2000 },
      { kind: "delay", milliseconds: 30 },
      {
        kind: "file",
        input: "recorded_file_2",
        offset: "1",
        length: "768",
        chunkBytes: "256",
        bytesPerSecond: "1048576",
        interChunkMs: "2",
        writeWaitMs: "2000",
      },
    ],
  });
  expect(inspectSequenceDraft(definition).plan[2]).toMatchObject({
    kind: "file",
    input: "recorded_file_2",
    path: "$.steps[2]",
    length: "768",
  });

  const interrupted = new ManualSendRecording("scope", target);
  const partial = interrupted.addFile(params, 50)!;
  await interrupted.settleFile(
    partial,
    admitted,
    { ...settled, state: "cancelled" },
    read,
    new AbortController().signal,
    80,
  );
  expect(interrupted.snapshot()).toMatchObject({
    phase: "ready",
    confirmed: 0,
    reason: "unconfirmed",
    definition: undefined,
  });
  expect(ordinals).toHaveLength(2);

  const mixed = new ManualSendRecording("scope", target);
  const prefix = mixed.add(first, 10, 2000)!;
  const ambiguousFile = mixed.addFile(params, 50)!;
  mixed.settle(prefix, tx("first"), receipt("first", first, 50), 20);
  interleaved = true;
  await mixed.settleFile(
    ambiguousFile,
    admitted,
    settled,
    read,
    new AbortController().signal,
    80,
  );
  expect(mixed.snapshot()).toMatchObject({
    phase: "ready",
    confirmed: 1,
    reason: "unconfirmed",
  });
  expect(draft(mixed)).toEqual({
    version: 1,
    steps: [{ kind: "send", hex: "00 FF", writeWaitMs: 2000 }],
  });
});

it("retains earlier writes when the next manual write has a deadline outside the replay budget", () => {
  const recording = new ManualSendRecording("scope", target);
  const one = recording.add(first, 1, 3200)!;
  recording.settle(one, tx("one"), receipt("one", first, 50), 2);
  expect(recording.add(second, 30, 5001)).toBeUndefined();
  expect(recording.snapshot()).toMatchObject({
    phase: "ready",
    reason: "limit",
    confirmed: 1,
  });
  expect(draft(recording)).toEqual({
    version: 1,
    steps: [{ kind: "send", hex: "00 FF", writeWaitMs: 3200 }],
  });
});

it("exports references without recorded bytes and resolves only the supplied HEX", () => {
  const recording = new ManualSendRecording("scope", target, true);
  const one = recording.add(first, 10, 3200)!;
  const two = recording.add(second, 51, 1010)!;
  recording.settle(one, tx("one"), receipt("one", first, 50), 25);
  recording.stop("user");
  recording.settle(two, tx("two"), receipt("two", second, 52), 60);
  const def = recording.snapshot().definition!;
  expect(def).not.toContain("00 FF");
  expect(JSON.parse(def)).toEqual({
    version: 1,
    variables: { recorded_send_1: null, recorded_send_2: null },
    steps: [
      { kind: "send", hex: "$" + "{recorded_send_1}", writeWaitMs: 3200 },
      { kind: "delay", milliseconds: 26 },
      { kind: "send", hex: "$" + "{recorded_send_2}", writeWaitMs: 1010 },
    ],
  });
  const review = inspectSequenceDraft(def);
  expect(review.inputs?.names).toEqual(["recorded_send_1", "recorded_send_2"]);
  expect(
    review.inputs?.bind(new Map([["recorded_send_1", "AB"]])),
  ).toBeUndefined();
  expect(() =>
    review.inputs?.bind(
      new Map([
        ["recorded_send_1", "AB"],
        ["recorded_send_2", "GG"],
      ]),
    ),
  ).toThrow("complete HEX");
  const bound = review.inputs?.bind(
    new Map([
      ["recorded_send_1", "AB"],
      ["recorded_send_2", "CD DE"],
    ]),
  );
  expect(bound).toBeDefined();
  const runtime = inspectSequenceDraft(bound!);
  expect(runtime.inputs).toBeUndefined();
  expect(
    runtime.plan
      .filter((step) => step.kind === "send")
      .map(({ bytes }) => [...bytes]),
  ).toEqual([[0xab], [0xcd, 0xde]]);
  expect(recording.snapshot().definition).toBe(def);
});
