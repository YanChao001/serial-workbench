import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ContractValidationError,
  parseReply,
  parseOperationsSnapshot,
  parseCaptureRecord,
  defaults,
  parseSharedSettings,
  type CaptureStartParams_Deserialize,
  type CaptureStorageLimits,
  type SessionInputs,
  type SessionMetrics,
  type SharedSettings_Deserialize,
  type TerminalTypography,
} from "./index";
import fixtures from "./generated/fixtures.json";
import generatedDefaults from "./generated/defaults.json";
import {
  validateCaptureStartParams,
  validateCaptureStorageLimits,
} from "./generated/validators.mjs";

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

describe("Rust capture storage limits contract", () => {
  const input = {
    sessionRefs: [],
    targetRef: { hostId: "host", kind: "file", id: "capture-target" },
    overflowPolicy: "stop",
  } satisfies CaptureStartParams_Deserialize;

  it("exports and validates the Rust-owned limits defaults", () => {
    const limits: CaptureStorageLimits = defaults.captureStorageLimits;
    expect(limits).toBe(generatedDefaults.captureStorageLimits);
    expect(limits).toEqual({
      capacityBytes: "1073741824",
      reserveBytes: "134217728",
    });
    expect(validateCaptureStorageLimits(limits)).toBe(true);
  });

  it("accepts omitted or complete limits in generated capture inputs", () => {
    expect(validateCaptureStartParams(input)).toBe(true);
    expect(
      validateCaptureStartParams({
        ...input,
        storageLimits: defaults.captureStorageLimits,
      }),
    ).toBe(true);
  });

  it.each([
    null,
    {},
    { capacityBytes: "0", reserveBytes: "0" },
    { capacityBytes: 1, reserveBytes: "0" },
    { capacityBytes: "1", reserveBytes: "18446744073709551616" },
    { capacityBytes: "1", reserveBytes: "0", extra: true },
  ])(
    "rejects malformed limits through root and input validators %#",
    (limits) => {
      expect(validateCaptureStorageLimits(limits)).toBe(false);
      expect(
        validateCaptureStartParams({ ...input, storageLimits: limits }),
      ).toBe(false);
    },
  );
});

describe("Rust session observability query contracts", () => {
  const metrics = {
    sessionId: "session",
    sessionEpoch: "2",
    instanceEpoch: "1",
    observedAt: "2026-11-07T00:00:00Z",
    observedMonoNs: "9007199254740993",
    connectionDurationMs: "1000",
    rxBytes: "9007199254740993",
    txAcceptedBytes: "5",
    txUnknownBytes: "1",
    rxReadErrors: "0",
    txWriteErrors: "0",
    rxBytesPerSecond: "10",
    txAcceptedBytesPerSecond: "5",
    rateWindowMs: "1000",
    rateResolutionMs: "10",
    lineErrorsAvailable: false,
    frameCountsAvailable: false,
  } satisfies SessionMetrics;
  const inputs = {
    sessionId: "session",
    sessionEpoch: "2",
    sampledAt: "2026-11-07T00:00:00Z",
    sampledMonoNs: "9007199254740993",
    cts: true,
    dsr: false,
    ri: true,
    cd: false,
  } satisfies SessionInputs;

  it.each([
    { kind: "session_metrics", value: metrics },
    { kind: "session_inputs", value: inputs },
  ])("accepts the generated $kind query reply", (result) => {
    const reply = { ok: true, result };
    expect(parseReply(reply)).toEqual(reply);
  });

  it.each([
    { kind: "session_metrics", value: { ...metrics, rxBytes: 1 } },
    {
      kind: "session_metrics",
      value: { ...metrics, lineErrorsAvailable: true },
    },
    { kind: "session_inputs", value: { ...inputs, sampledMonoNs: null } },
    { kind: "session_inputs", value: { ...inputs, cts: "true" } },
    { kind: "session_inputs", value: { ...inputs, extra: true } },
  ])("rejects malformed observability query reply %#", (result) => {
    expect(() => parseReply({ ok: true, result })).toThrow(
      ContractValidationError,
    );
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
describe("Rust terminal typography contract", () => {
  it("exports Rust-owned complete typography defaults", () => {
    expectTypeOf<
      TerminalTypography["lineHeightPercent"]
    >().toEqualTypeOf<number>();
    const typography: TerminalTypography = defaults.terminalTypography;
    expect(typography).toBe(generatedDefaults.terminalTypography);
    expect(typography).toEqual({
      fontFamily: "ui-monospace",
      fontSize: 14,
      lineHeightPercent: 150,
      ligatures: false,
    });
    expect(defaults.settings.terminal.typography).toEqual(typography);
  });

  it("accepts the generated input type without the new field", () => {
    const input = {
      ...defaults.settings,
      terminal: {
        receiveMode: "text",
        sendMode: "hex",
        lineEnding: { kind: "crlf" },
      },
    } satisfies SharedSettings_Deserialize;
    const parsed = parseSharedSettings(input);
    expect(parsed).toEqual(input);
    expect(parsed.terminal.typography ?? defaults.terminalTypography).toBe(
      defaults.terminalTypography,
    );
  });

  it.each([
    { fontFamily: "a", fontSize: 8, lineHeightPercent: 100, ligatures: false },
    {
      fontFamily: "🦀".repeat(128),
      fontSize: 48,
      lineHeightPercent: 300,
      ligatures: true,
    },
  ])("accepts complete boundary typography %#", (typography) => {
    const input = {
      ...defaults.settings,
      terminal: { ...defaults.settings.terminal, typography },
    } satisfies SharedSettings_Deserialize;
    expect(parseSharedSettings(input)).toEqual(input);
  });

  it.each([
    { fontFamily: "" },
    { fontFamily: "mono\nspace" },
    { fontFamily: "mono\n" },
    { fontFamily: "mono\u007f" },
    { fontFamily: "mono\u0085" },
    { fontFamily: "\uD800" },
    { fontFamily: "\uDC00" },
    { fontFamily: "🦀".repeat(129) },
    { fontSize: 7 },
    { fontSize: 49 },
    { lineHeightPercent: 99 },
    { lineHeightPercent: 301 },
    { lineHeightPercent: 150.5 },
    { lineHeightPercent: "150" },
    { lineHeightPercent: null },
    { ligatures: "true" },
    { legacyFont: "mono" },
  ])("rejects invalid typography %#", (patch) => {
    expect(() =>
      parseSharedSettings({
        ...defaults.settings,
        terminal: {
          ...defaults.settings.terminal,
          typography: { ...defaults.terminalTypography, ...patch },
        },
      }),
    ).toThrow(ContractValidationError);
  });

  it.each(["fontFamily", "fontSize", "lineHeightPercent", "ligatures"])(
    "requires the inner %s field",
    (field) => {
      const typography: Record<string, unknown> = {
        ...defaults.terminalTypography,
      };
      delete typography[field];
      expect(() =>
        parseSharedSettings({
          ...defaults.settings,
          terminal: { ...defaults.settings.terminal, typography },
        }),
      ).toThrow(ContractValidationError);
    },
  );

  it.each(["receiveMode", "sendMode", "lineEnding"])(
    "keeps the original %s field required",
    (field) => {
      const terminal: Record<string, unknown> = {
        ...defaults.settings.terminal,
      };
      delete terminal[field];
      expect(() =>
        parseSharedSettings({ ...defaults.settings, terminal }),
      ).toThrow(ContractValidationError);
    },
  );

  it.each([
    {
      ...defaults.settings,
      terminal: { ...defaults.settings.terminal, typography: null },
    },
    { version: 7, terminalFont: "mono" },
    { formatVersion: "99.0", value: defaults.settings },
  ])("rejects null typography or foreign format inputs %#", (value) => {
    expect(() => parseSharedSettings(value)).toThrow(ContractValidationError);
  });
});
