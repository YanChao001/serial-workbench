import { expect, it } from "vitest";
import type { HostError } from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import { en } from "@/i18n/en";
import { zhCN } from "@/i18n/zh-CN";
import { createTranslator } from "@/i18n/translate";
import {
  rfc2217OpenDiagnostic,
  rfc2217OpenDiagnosticText,
} from "./rfc2217-open-diagnostic";

const failure = (
  details: NonNullable<HostError["details"]>,
  code = "PLUGIN_TRANSPORT_OPEN_FAILED",
) =>
  new HostRequestError({
    code,
    message: "Provider output",
    retryable: false,
    details,
  });

it("presents the request and the actual RFC 2217 reply in both languages", () => {
  const diagnostic = rfc2217OpenDiagnostic(
    failure({
      protocol: "rfc2217",
      reason: "different_value",
      field: "baudRate",
      requestedValue: 115200,
      reportedValue: 9600,
    }),
  )!;
  expect(rfc2217OpenDiagnosticText(diagnostic, createTranslator(en))).toBe(
    "Baud rate mismatch. Requested 115200\u00a0bit/s, but the remote endpoint reported 9600\u00a0bit/s.",
  );
  expect(rfc2217OpenDiagnosticText(diagnostic, createTranslator(zhCN))).toBe(
    "波特率不一致。请求 115200\u00a0bit/s，对端回报 9600\u00a0bit/s。",
  );
});

it("uses the existing serial option names for a control line mismatch", () => {
  const diagnostic = rfc2217OpenDiagnostic(
    failure({
      protocol: "rfc2217",
      reason: "different_value",
      field: "dtr",
      requestedValue: 8,
      reportedValue: 9,
    }),
  )!;
  expect(rfc2217OpenDiagnosticText(diagnostic, createTranslator(en))).toBe(
    "DTR mismatch. Requested Set, but the remote endpoint reported Clear.",
  );
});

it("leaves unrecognized or impossible details with the existing generic error", () => {
  const shape = {
    protocol: "rfc2217",
    reason: "different_value",
    field: "parity",
    requestedValue: 1,
    reportedValue: 2,
  };
  for (const details of [
    { ...shape, protocol: "other" },
    { ...shape, field: "endpoint secret" },
    { ...shape, reportedValue: 256 },
    { ...shape, reportedValue: "raw provider output" },
    { ...shape, reportedValue: 1 },
  ]) {
    expect(rfc2217OpenDiagnostic(failure(details))).toBeUndefined();
  }
  expect(rfc2217OpenDiagnostic(failure(shape, "DEVICE_BUSY"))).toBeUndefined();
});
