import {
  ContractValidationError,
  type JsonValue,
} from "@serial-workbench/contracts";

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null) return rpcJsonObject(value);
  throw new ContractValidationError("Host parameters contain a non-JSON value");
}

export function rpcJsonObject(value: object): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([key, field]) => [key, jsonValue(field)]),
  );
}
