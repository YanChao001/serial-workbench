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

const modbusLine: LineSettings = {
  ...textLine,
  baudRate: "19200",
  parity: "even",
};

export const sessionTemplates = {
  stm32: { line: textLine },
  arduino: { line: textLine, project: "arduino" },
  at: { line: textLine, project: "at" },
  modbus: { line: modbusLine },
  modbusRead: { line: modbusLine, project: "modbus" },
} satisfies Record<
  string,
  { line: LineSettings; project?: "arduino" | "at" | "modbus" }
>;

export function supportsSessionTemplates(transport?: DeviceTransportKind) {
  return (
    transport === "serial" || transport === "pty" || transport === "virtual"
  );
}
