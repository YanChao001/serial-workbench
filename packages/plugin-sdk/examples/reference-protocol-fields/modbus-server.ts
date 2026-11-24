import { ProtocolFieldError } from "../reference-framing/protocol-fields.ts";
import type { ModbusUnitRouting } from "./modbus-exchange.ts";
import {
  decodeModbusAdu,
  encodeModbusFrame,
  type ModbusTransport,
} from "./modbus-frame.ts";
import {
  decodeModbusPdu,
  isModbusWrite,
  modbusInteger,
  modbusKeys,
  modbusRecord,
} from "./modbus-pdu.ts";

export const modbusServerLimits = {
  blocks: 16,
  cells: 2000,
  definition: 65536,
};
type Cell = boolean | number;
type Block = { start: number; values: Cell[] };
const functionTables = {
  1: "coils",
  2: "discreteInputs",
  3: "holdingRegisters",
  4: "inputRegisters",
  5: "coils",
  6: "holdingRegisters",
  15: "coils",
  16: "holdingRegisters",
} as const;
type ServerFunction = keyof typeof functionTables;
type TableName = (typeof functionTables)[ServerFunction];
const tableNames = [
  "coils",
  "discreteInputs",
  "holdingRegisters",
  "inputRegisters",
] as const;
type Fault = { functionCode: ServerFunction } & (
  { behavior: "silent" } | { behavior: "exception"; exceptionCode: number }
);
type ModbusServerModel = {
  unitId: number;
  tables: Record<TableName, Block[]>;
  faults: Fault[];
};

type ModbusServerResult = { model: ModbusServerModel } & (
  | { status: "ignored" | "silent" | "broadcast" }
  | { status: "discarded"; path: string }
  | { status: "replied"; responseBytes: Uint8Array }
  | { status: "exception"; responseBytes: Uint8Array; exceptionCode: number }
);

function boundedList(
  value: unknown,
  path: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new ProtocolFieldError(
      path,
      `Expected an array with at most ${maximum} items`,
    );
  return Array.from(value);
}

function readTable(value: unknown, name: TableName): Block[] {
  if (value === undefined) return [];
  const path = `model.tables.${name}`;
  const bits = name === "coils" || name === "discreteInputs";
  let cells = 0;
  const blocks = boundedList(value, path, modbusServerLimits.blocks)
    .map((entry, index) => {
      const blockPath = `${path}[${index}]`;
      const block = modbusRecord(entry, blockPath);
      modbusKeys(block, ["start", "values"], blockPath);
      const start = modbusInteger(block.start, 0, 65535, `${blockPath}.start`);
      const values = boundedList(
        block.values,
        `${blockPath}.values`,
        modbusServerLimits.cells,
      );
      if (values.length === 0 || start + values.length > 65536)
        throw new ProtocolFieldError(
          blockPath,
          "Empty or out-of-range address block",
        );
      cells += values.length;
      if (cells > modbusServerLimits.cells)
        throw new ProtocolFieldError(
          path,
          "Table exceeds the simulator cell limit",
        );
      return {
        start,
        values: values.map((item, cellIndex) => {
          const cellPath = `${blockPath}.values[${cellIndex}]`;
          if (!bits) return modbusInteger(item, 0, 65535, cellPath);
          if (typeof item === "boolean") return item;
          throw new ProtocolFieldError(cellPath, "Expected a Boolean");
        }),
      };
    })
    .sort((left, right) => left.start - right.start);
  const merged: Block[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    const nextAddress = previous ? previous.start + previous.values.length : -1;
    if (previous && block.start < nextAddress)
      throw new ProtocolFieldError(path, "Address blocks overlap");
    if (previous && block.start === nextAddress)
      previous.values.push(...block.values);
    else merged.push(block);
  }
  return merged;
}

function readFaults(value: unknown): Fault[] {
  if (value === undefined) return [];
  const seen = new Set<number>();
  return boundedList(value, "model.faults", 8).map((entry, index) => {
    const path = `model.faults[${index}]`;
    const rule = modbusRecord(entry, path);
    const code = rule.functionCode;
    if (
      typeof code !== "number" ||
      !Object.hasOwn(functionTables, code) ||
      seen.has(code)
    )
      throw new ProtocolFieldError(
        `${path}.functionCode`,
        "Expected a unique supported function",
      );
    seen.add(code);
    const functionCode = code as ServerFunction;
    if (rule.behavior === "silent") {
      modbusKeys(rule, ["functionCode", "behavior"], path);
      return { functionCode, behavior: "silent" };
    }
    if (rule.behavior === "exception") {
      modbusKeys(rule, ["functionCode", "behavior", "exceptionCode"], path);
      return {
        functionCode,
        behavior: "exception",
        exceptionCode: modbusInteger(
          rule.exceptionCode,
          1,
          255,
          `${path}.exceptionCode`,
        ),
      };
    }
    throw new ProtocolFieldError(
      `${path}.behavior`,
      "Expected silent or exception",
    );
  });
}

export function parseModbusServerModel(value: unknown): ModbusServerModel {
  const input = modbusRecord(value, "model");
  modbusKeys(input, ["unitId", "tables", "faults"], "model");
  const tables = modbusRecord(input.tables, "model.tables");
  modbusKeys(tables, tableNames, "model.tables");
  return {
    unitId: modbusInteger(input.unitId, 0, 255, "model.unitId"),
    tables: {
      coils: readTable(tables.coils, "coils"),
      discreteInputs: readTable(tables.discreteInputs, "discreteInputs"),
      holdingRegisters: readTable(tables.holdingRegisters, "holdingRegisters"),
      inputRegisters: readTable(tables.inputRegisters, "inputRegisters"),
    },
    faults: readFaults(input.faults),
  };
}

function readBits(values: readonly Cell[]) {
  const bitBytes = Array<number>(Math.ceil(values.length / 8)).fill(0);
  for (const [index, value] of values.entries())
    if (value === true) {
      const byteIndex = index >>> 3;
      bitBytes[byteIndex] = bitBytes[byteIndex]! | (1 << (index % 8));
    }
  return bitBytes;
}

export function simulateModbusServer(
  transport: ModbusTransport,
  requestBytes: Uint8Array,
  definition: unknown,
  unitRouting: ModbusUnitRouting = "gateway",
): ModbusServerResult {
  // A canonical copy lets an unsuccessful request leave the caller's snapshot intact.
  const model = parseModbusServerModel(definition);
  if (transport !== "tcp") modbusInteger(model.unitId, 1, 247, "model.unitId");
  let adu: ReturnType<typeof decodeModbusAdu>;
  try {
    adu = decodeModbusAdu(transport, requestBytes);
  } catch (error) {
    if (!(error instanceof ProtocolFieldError)) throw error;
    return { status: "discarded", path: error.path, model };
  }
  const isSerial = transport !== "tcp";
  const broadcast = isSerial && adu.unitId === 0;
  if (isSerial && adu.unitId > 247)
    return { status: "discarded", path: "packet.unitId", model };
  if (
    !broadcast &&
    (isSerial || unitRouting === "gateway") &&
    adu.unitId !== model.unitId
  )
    return { status: "ignored", model };

  const functionCode = adu.pdu[0]!;
  if (
    functionCode < 1 ||
    functionCode > 127 ||
    (broadcast && !isModbusWrite(functionCode))
  )
    return { status: "discarded", path: "pdu.functionCode", model };

  const address = {
    unitId: adu.unitId,
    ...("transactionId" in adu ? { transactionId: adu.transactionId } : {}),
  };
  const reply = (pdu: unknown) =>
    encodeModbusFrame(transport, "response", { ...address, pdu });
  const reject = (exceptionCode: number, path: string): ModbusServerResult =>
    broadcast
      ? { status: "discarded", path, model }
      : {
          status: "exception",
          exceptionCode,
          model,
          responseBytes: reply({ functionCode, exceptionCode }),
        };
  if (!Object.hasOwn(functionTables, functionCode))
    return reject(1, "pdu.functionCode");
  let request: ReturnType<typeof decodeModbusPdu>;
  try {
    request = decodeModbusPdu(adu.pdu, "request");
  } catch (error) {
    if (!(error instanceof ProtocolFieldError)) throw error;
    return reject(error.path === "pdu.address" ? 2 : 3, error.path);
  }
  if (!("address" in request)) return reject(3, "pdu.address");
  const fault = model.faults.find(
    (entry) => entry.functionCode === request.functionCode,
  );
  if (fault?.behavior === "silent") return { status: "silent", model };
  if (fault?.behavior === "exception")
    return reject(fault.exceptionCode, "model.faults");

  const values =
    "quantity" in request
      ? undefined
      : "value" in request
        ? [request.value]
        : request.values;
  const quantity = "quantity" in request ? request.quantity : values!.length;
  const table = model.tables[functionTables[request.functionCode]];
  const block = table.find(
    (candidate) =>
      candidate.start <= request.address &&
      request.address + quantity <= candidate.start + candidate.values.length,
  );
  if (!block) return reject(2, "pdu.address");
  const offset = request.address - block.start;
  if (values) {
    block.values.splice(offset, quantity, ...values);
    if (broadcast) return { status: "broadcast", model };
    const response =
      "value" in request
        ? request
        : { functionCode, address: request.address, quantity };
    return { status: "replied", model, responseBytes: reply(response) };
  }
  const read = block.values.slice(offset, offset + quantity);
  const response =
    functionCode <= 2
      ? { functionCode, bitBytes: readBits(read) }
      : { functionCode, values: read };
  return { status: "replied", model, responseBytes: reply(response) };
}
