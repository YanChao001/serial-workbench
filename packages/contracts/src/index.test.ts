import { describe, expect, it } from "vitest";
import { ContractValidationError, parseReply } from "./index";

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
