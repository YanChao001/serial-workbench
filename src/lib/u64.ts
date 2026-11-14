export const U64_MAX = 18446744073709551615n;

/** 先限制十进制输入长度，再分配 BigInt；与 wire 一样只接受规范形式。 */
export function parseU64(value: unknown): bigint | undefined {
  if (
    typeof value !== "string" ||
    value.length > 20 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  )
    return;
  const parsed = BigInt(value);
  return parsed <= U64_MAX ? parsed : undefined;
}
