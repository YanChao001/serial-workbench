import type {
  DeviceTransportKind,
  SerialConfiguration,
} from "@serial-workbench/contracts";

type LineSettings = Pick<
  SerialConfiguration,
  "baudRate" | "dataBits" | "parity" | "stopBits" | "flowControl"
>;

const textLine: LineSettings = {
  baudRate: "115200",
  dataBits: "8",
  parity: "none",
  stopBits: "one",
  flowControl: "none",
};

export const sessionTemplates = {
  stm32: { line: textLine },
  at: { line: textLine },
  modbus: { line: { ...textLine, baudRate: "19200", parity: "even" } },
} satisfies Record<string, { line: LineSettings }>;

export function supportsSessionTemplates(transport?: DeviceTransportKind) {
  return (
    transport === "serial" || transport === "pty" || transport === "virtual"
  );
}
