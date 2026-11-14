import type { SerialConfiguration } from "@serial-workbench/contracts";
import { parseU64, U64_MAX } from "@/lib/u64";

export const CONFIG_FIELDS = [
  "baudRate",
  "dataBits",
  "parity",
  "stopBits",
  "flowControl",
  "readWaitMs",
  "writeWaitMs",
  "reconnectBackoffMs",
] as const;
export const BAUD_PRESETS = [
  "1200",
  "2400",
  "4800",
  "9600",
  "19200",
  "38400",
  "57600",
  "115200",
  "230400",
  "460800",
  "921600",
];

// 表单只限制 wire 数字的可表示范围；驱动组合及执行语义仍由 Host 裁定。
export function validInteger(value: string, maximum: bigint) {
  const parsed = parseU64(value);
  return parsed !== undefined && parsed > 0n && parsed <= maximum;
}
export function validDuration(value: string) {
  return validInteger(value, 2147483647n);
}

export function validBaudRate(value: string) {
  return validInteger(value, U64_MAX);
}

export function validSerialConfiguration(value: SerialConfiguration): boolean {
  return (
    validBaudRate(value.baudRate) &&
    validDuration(value.readWaitMs) &&
    validDuration(value.writeWaitMs) &&
    validDuration(value.reconnectBackoffMs)
  );
}
