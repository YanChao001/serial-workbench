import { describe, expect, it } from "vitest";
import fixtures from "./generated/fixtures.json";
import * as generatedValidators from "./generated/validators.mjs";
import { ContractValidationError, parseReply } from "./index";

// 同一份由 Rust exporter 产生的向量同时验证 Rust 与浏览器边界。
const validators: Record<string, (value: unknown) => boolean> =
  generatedValidators;

describe("Rust-exported wire fixtures", () => {
  it.each(fixtures.valid)("accepts $name ($schema)", ({ schema, value }) => {
    const validate = validators[`validate${schema}`];
    expect(validate, `missing validator for ${schema}`).toBeDefined();
    expect(validate?.(value)).toBe(true);
    if (schema === "RpcReply") expect(parseReply(value)).toEqual(value);
  });

  it.each(fixtures.invalid)("rejects $name ($schema)", ({ schema, value }) => {
    const validate = validators[`validate${schema}`];
    expect(validate, `missing validator for ${schema}`).toBeDefined();
    expect(validate?.(value)).toBe(false);
    if (schema === "RpcReply")
      expect(() => parseReply(value)).toThrow(ContractValidationError);
  });
});
