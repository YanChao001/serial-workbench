import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  parseReply,
  parseWireFrame,
} from "./index.ts";
import {
  parseViewDerivedPage,
  parseViewRawBatch,
  parseViewSession,
} from "./view.ts";
import fixtures from "./generated/fixtures.json";

function fixture(name: string): unknown {
  const row = fixtures.valid.find((entry) => entry.name === name);
  if (!row) throw new Error("Missing Rust fixture " + name);
  return row.value;
}

describe("plugin view envelopes", () => {
  it("accepts the same session and derived payloads as the Host reply", () => {
    for (const [kind, value, parse] of [
      ["session", fixture("session-snapshot-with-lease"), parseViewSession],
      [
        "stream_derived_read",
        fixture("derived-read-result"),
        parseViewDerivedPage,
      ],
    ] as const) {
      const reply = { ok: true, result: { kind, value } };
      expect(parseReply(reply)).toBe(reply);
      expect(parse(reply)).toBe(value);
      expect(() => parse({ ...reply, error: null })).toThrow(
        ContractValidationError,
      );
      expect(() =>
        parse({ ok: true, result: { kind, value, extra: true } }),
      ).toThrow(ContractValidationError);
      expect(() => parse({ ok: true, result: { kind, value: {} } })).toThrow(
        ContractValidationError,
      );
    }

    expect(() => parseViewSession(fixture("reply-error"))).toThrow(
      "Missing plugin session snapshot",
    );
    expect(() => parseViewDerivedPage(fixture("reply-operation"))).toThrow(
      ContractValidationError,
    );
  });

  it("accepts the Rust raw batch envelope and rejects a different channel or malformed payload", () => {
    const batch = fixture("raw-source-batch");
    const frame = {
      requestId: "00000000-0000-0000-0000-000000000001",
      channel: "raw",
      body: { type: "rawBatch", batch },
    };
    expect(parseWireFrame(frame)).toBe(frame);
    expect(parseViewRawBatch(frame)).toBe(batch);
    for (const invalid of [
      { ...frame, channel: "control" },
      { ...frame, requestId: "not-a-request-id" },
      { ...frame, body: { ...frame.body, batch: {} } },
      { ...frame, body: { ...frame.body, extra: true } },
      { ...frame, extra: true },
    ]) {
      expect(() => parseViewRawBatch(invalid)).toThrow(ContractValidationError);
    }
  });
});
