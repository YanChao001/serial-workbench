import { ContractValidationError } from "./contract-validation-error.ts";
import {
  validateDerivedReadResult,
  validateHostError,
  validateRawBatch,
  validateRequestId,
  validateSessionSnapshot,
} from "./generated/view-validators.mjs";

export { ContractValidationError } from "./contract-validation-error.ts";

function onlyFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function viewResult<Value>(
  input: unknown,
  kind: "session" | "stream_derived_read",
  validate: (value: unknown) => value is Value,
  missingMessage: string,
): Value {
  if (
    onlyFields(input, ["ok", "result"]) &&
    input.ok === true &&
    onlyFields(input.result, ["kind", "value"]) &&
    input.result.kind === kind &&
    validate(input.result.value)
  )
    return input.result.value;

  if (
    onlyFields(input, ["ok", "error"]) &&
    input.ok === false &&
    validateHostError(input.error)
  )
    throw new ContractValidationError(missingMessage);
  throw new ContractValidationError();
}

export function parseViewSession(input: unknown) {
  return viewResult(
    input,
    "session",
    validateSessionSnapshot,
    "Missing plugin session snapshot",
  );
}

export function parseViewDerivedPage(input: unknown) {
  return viewResult(
    input,
    "stream_derived_read",
    validateDerivedReadResult,
    "Missing derived viewer page",
  );
}

export function parseViewRawBatch(input: unknown) {
  if (
    !onlyFields(input, ["requestId", "channel", "body"]) ||
    input.channel !== "raw" ||
    !validateRequestId(input.requestId) ||
    !onlyFields(input.body, ["type", "batch"]) ||
    input.body.type !== "rawBatch" ||
    !validateRawBatch(input.body.batch)
  )
    throw new ContractValidationError("Invalid plugin view frame");
  return input.body.batch;
}
