import { parseHex } from "../../src/hex.ts";

export const maxRuleResponseDelayMs = 10_000;

export function parseRuleResponseDelay(value: unknown): number {
  if (value === undefined) return 0;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > maxRuleResponseDelayMs
  )
    throw new Error("Invalid rule response delay");
  return value;
}

export function parseRuleRequestHex(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("Invalid HEX request");
  const bytes = parseHex(value);
  if (bytes.length === 0 || bytes.length > 256)
    throw new Error("A HEX request must contain between 1 and 256 bytes");
  return bytes;
}
