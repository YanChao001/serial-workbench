/** wire 计数始终保留十进制整数，显示换算不经过浮点数。 */
export function formatByteSize(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const bytes = BigInt(value);
  const units = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  let divisor = 1n;
  let unit = 0;
  while (bytes >= divisor * 1000n && unit < units.length - 1) {
    divisor *= 1000n;
    unit++;
  }
  if (unit === 0) return `${bytes} B`;
  const scaled = (bytes * 100n + divisor / 2n) / divisor;
  return `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, "0")} ${units[unit]}`;
}

export function formatElapsedTime(milliseconds: string): string {
  const seconds = BigInt(milliseconds) / 1000n;
  return [seconds / 3600n, (seconds / 60n) % 60n, seconds % 60n]
    .map((part) => part.toString().padStart(2, "0"))
    .join(":");
}
