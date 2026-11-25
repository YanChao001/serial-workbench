export const maxU64 = (1n << 64n) - 1n;

export function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(path + " must be an object");
  return value as Record<string, unknown>;
}

export function u64(value: unknown, path: string) {
  if (typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= maxU64) return parsed;
  }
  throw new Error(path + " must be an unsigned 64-bit decimal string");
}

export function positive(value: unknown, path: string) {
  const parsed = u64(value, path);
  if (!parsed) throw new Error(path + " must be positive");
  return parsed;
}

export function seriesIdentifier(value: unknown, path: string) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
  )
    throw new Error(path + " must be a valid identifier");
  return value;
}

export function decimal(value: unknown, path: string, maxLength = 64) {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) ||
    !Number.isFinite(Number(value))
  )
    throw new Error(path + " must be a finite decimal string");
  return value;
}
