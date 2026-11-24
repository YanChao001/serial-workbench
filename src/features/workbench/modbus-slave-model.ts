import {
  ContractValidationError,
  type Target,
} from "@serial-workbench/contracts";
import { isRecord } from "@/lib/settings-model";
import { parseU64 } from "@/lib/u64";
import { parseModbusServerModel } from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-server";

export const modbusSlaveAction = "swb.reference.modbus.slave.serve";
const reasons = [
  "request_limit",
  "receive_deadline",
  "source_changed",
  "session_ended",
  "invalid_stream",
  "byte_limit",
  "lease_unavailable",
  "reply_unconfirmed",
] as const;
const outcomes = [
  "ignored",
  "silent",
  "broadcast",
  "discarded",
  "replied",
  "exception",
] as const;

function invalid(): never {
  throw new ContractValidationError("Invalid Modbus slave result");
}

export function parseModbusSlaveReport(value: unknown, target: Target) {
  if (!isRecord(value)) return invalid();
  const reason = reasons.find((item) => item === value.reason);
  if (!reason || !Array.isArray(value.processed) || value.processed.length > 64)
    return invalid();
  const processed = value.processed.map((entry: unknown) => {
    if (!isRecord(entry) || !isRecord(entry.source)) return invalid();
    const { source, tx } = entry;
    const status = outcomes.find((item) => item === entry.status);
    const byteStart = parseU64(source.byteStart);
    const byteEnd = parseU64(source.byteEnd);
    const eventStart = parseU64(source.eventStart);
    const eventEnd = parseU64(source.eventEnd);
    if (
      !status ||
      source.hostId !== target.hostId ||
      source.sessionId !== target.sessionId ||
      source.sessionEpoch !== target.sessionEpoch ||
      source.direction !== "rx" ||
      byteStart === undefined ||
      byteEnd === undefined ||
      byteEnd <= byteStart ||
      eventStart === undefined ||
      eventEnd === undefined ||
      eventEnd <= eventStart ||
      (tx !== undefined && (!isRecord(tx) || typeof tx.confirmed !== "boolean"))
    )
      return invalid();
    return {
      status,
      byteStart,
      byteEnd,
      eventStart,
      eventEnd,
      confirmed: tx?.confirmed,
    };
  });
  return { reason, model: parseModbusServerModel(value.model), processed };
}
