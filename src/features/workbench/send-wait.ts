import type { SerialConfiguration } from "@serial-workbench/contracts";
import type { WriteWaitMode } from "@/lib/generated/bindings";

/** GUI 策略只生成本次操作的有界时限；Host 的 writeWaitMs 仍是绝对写入预算。 */
export function sendWaitMs(
  configuration: SerialConfiguration,
  byteLength: number,
  mode: WriteWaitMode = "automatic",
): string {
  if (mode === "fixed") return configuration.writeWaitMs;
  const parity = configuration.parity === "none" ? 0 : 1;
  const stop = { one: 2, onePointFive: 3, two: 4 }[configuration.stopBits];
  const halfBits = BigInt(
    2 * (1 + Number(configuration.dataBits) + parity) + stop,
  );
  const baud = BigInt(configuration.baudRate);
  const wireMs = (BigInt(byteLength) * halfBits * 500n + baud - 1n) / baud;
  // 至少留一秒调度/驱动余量；长传输保留四分之一线路时间，持续流控仍可超时。
  const margin = (wireMs + 3n) / 4n;
  const wait = wireMs + (margin > 1000n ? margin : 1000n);
  return String(wait > 2147483647n ? 2147483647n : wait);
}
