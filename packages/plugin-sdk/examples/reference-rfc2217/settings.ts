import type { TransportOpenOptions } from "@serial-workbench/plugin-sdk/node";
import {
  defaultTcpHost,
  tcpHostPattern,
} from "../reference-transport/tcp-endpoint.ts";

const parityCodes = { none: 1, odd: 2, even: 3, mark: 4, space: 5 };
const stopCodes = { "1": 1, "2": 2, "1.5": 3 };
const flowCodes = { none: 1, software: 2, hardware: 3 };

export const rfc2217LineCodes = {
  dtr: { on: 8, off: 9 },
  rts: { on: 11, off: 12 },
} as const;

export type SettingRequest = {
  command: number;
  field: string;
  value: Uint8Array;
};

function code(
  table: Record<string, number>,
  value: unknown,
): number | undefined {
  return typeof value === "string" && Object.hasOwn(table, value)
    ? table[value]
    : undefined;
}

function integer(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

export function rfc2217Settings(params: TransportOpenOptions["params"]) {
  const {
    host = defaultTcpHost,
    port,
    baudRate,
    dataBits = 8,
    parity = "none",
    stopBits = "1",
    flowControl = "none",
    dtr,
    rts,
    ...unknown
  } = params;
  const parityCode = code(parityCodes, parity);
  const stopCode = code(stopCodes, stopBits);
  const flowCode = code(flowCodes, flowControl);
  if (
    Object.keys(unknown).length > 0 ||
    typeof host !== "string" ||
    !tcpHostPattern.test(host) ||
    !integer(port, 1, 65535) ||
    !integer(baudRate, 1, 0xffffffff) ||
    !integer(dataBits, 5, 8) ||
    parityCode === undefined ||
    stopCode === undefined ||
    flowCode === undefined ||
    (stopBits === "1.5" && dataBits !== 5) ||
    (dtr !== undefined && typeof dtr !== "boolean") ||
    (rts !== undefined && typeof rts !== "boolean") ||
    (rts !== undefined && flowControl === "hardware")
  )
    throw new Error("Invalid RFC 2217 connection parameters");

  const baudBytes = new Uint8Array(4);
  new DataView(baudBytes.buffer).setUint32(0, baudRate);
  const requests: SettingRequest[] = [
    { command: 1, field: "baudRate", value: baudBytes },
    { command: 2, field: "dataBits", value: Uint8Array.of(dataBits) },
    { command: 3, field: "parity", value: Uint8Array.of(parityCode) },
    { command: 4, field: "stopBits", value: Uint8Array.of(stopCode) },
    { command: 5, field: "flowControl", value: Uint8Array.of(flowCode) },
  ];
  if (dtr !== undefined)
    requests.push({
      command: 5,
      field: "dtr",
      value: Uint8Array.of(
        dtr ? rfc2217LineCodes.dtr.on : rfc2217LineCodes.dtr.off,
      ),
    });
  if (rts !== undefined)
    requests.push({
      command: 5,
      field: "rts",
      value: Uint8Array.of(
        rts ? rfc2217LineCodes.rts.on : rfc2217LineCodes.rts.off,
      ),
    });
  return { host, port, requests, hardwareFlow: flowControl === "hardware" };
}
