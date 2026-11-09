import type { SerialConfiguration } from "@serial-workbench/contracts";

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
  return (
    /^[1-9][0-9]*$/.test(value) &&
    value.length <= 20 &&
    BigInt(value) <= maximum
  );
}
export function validDuration(value: string) {
  return validInteger(value, 2147483647n);
}

export function validBaudRate(value: string) {
  return validInteger(value, 18446744073709551615n);
}

export function validSerialConfiguration(value: SerialConfiguration): boolean {
  return (
    validBaudRate(value.baudRate) &&
    validDuration(value.readWaitMs) &&
    validDuration(value.writeWaitMs) &&
    validDuration(value.reconnectBackoffMs)
  );
}
