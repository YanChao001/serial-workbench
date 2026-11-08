import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  parseReply,
  parseOperationsSnapshot,
  parseCaptureRecord,
} from "./index";
import fixtures from "./generated/fixtures.json";

describe("parseReply", () => {
  it.each(
    [
      undefined,
      null,
      1,
      "reply",
      [],
      {},
      { ok: true },
      { ok: false },
      { ok: true, result: null },
    ].map((value: unknown) => ({ value })),
  )("rejects an invalid unknown reply: $value", ({ value }) => {
    expect(() => parseReply(value)).toThrow(ContractValidationError);
  });

  it("returns a success reply with its generated discriminated union type", () => {
    const reply = parseReply({ ok: true, result: { closed: true } });
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.result).toEqual({ closed: true });
  });

  it("returns a failure reply with its generated discriminated union type", () => {
    const reply = parseReply({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "Invalid input",
        retryable: false,
      },
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("INVALID_ARGUMENT");
  });
});

describe("parseOperationsSnapshot", () => {
  const candidate = fixtures.valid.find(
    (fixture) => fixture.schema === "Operation",
  );
  if (!candidate) throw new Error("Operation fixture missing");
  const reply = parseReply({
    ok: true,
    result: { operation: candidate.value },
  });
  if (!reply.ok || !("operation" in reply.result)) throw new Error("fixture");
  const operation = reply.result.operation;
  const summary = {
    operationId: operation.operationId,
    executionHostId: operation.executionHostId,
    actorId: operation.actorId,
    actionId: operation.actionId,
    target: operation.target,
    executionMode: operation.executionMode,
    state: operation.state,
    revision: operation.revision,
    revealTarget: operation.revealTarget,
    acceptedAt: operation.acceptedAt,
  };
  it("accepts safe generated summary fields without inventing operation details", () => {
    expect(parseOperationsSnapshot({ items: [summary] })).toEqual({
      items: [summary],
    });
    expect(parseOperationsSnapshot({ items: [] })).toEqual({ items: [] });
  });
  it.each([
    undefined,
    null,
    {},
    { items: [{}] },
    { items: [{ ...summary, target: null }] },
    { items: [operation] },
    { items: [{ ...summary, result: {} }] },
  ])("rejects malformed or full-detail metadata %#", (value) => {
    expect(() => parseOperationsSnapshot(value)).toThrow(
      ContractValidationError,
    );
  });
});

describe("parseCaptureRecord", () => {
  const record = {
    recordOrdinal: "1",
    entry: {
      kind: "reader_gap",
      value: {
        hostId: "host",
        instanceEpoch: "1",
        sessionId: "session",
        sessionEpoch: "1",
        reason: "reader_overflow",
        missingEventRange: { start: "1", end: "2" },
      },
    },
  };
  it("accepts a generated capture record without a permissive cast", () => {
    expect(parseCaptureRecord(record)).toEqual(record);
  });
  it.each([
    null,
    {},
    { ...record, recordOrdinal: 1 },
    { ...record, entry: {} },
    { ...record, extra: true },
  ])("rejects malformed capture record %#", (value) => {
    expect(() => parseCaptureRecord(value)).toThrow(ContractValidationError);
  });
});
