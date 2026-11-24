import { ProtocolFieldError } from "../reference-framing/protocol-fields.ts";
import { decodeModbusFrame, type ModbusTransport } from "./modbus-frame.ts";
import type { ModbusDirection } from "./modbus-pdu.ts";

export type ModbusUnitRouting = "gateway" | "direct";

type MismatchReason =
  | "transaction-id"
  | "unit-id"
  | "function-code"
  | "read-count"
  | "padding"
  | "write-address"
  | "write-echo"
  | "write-count"
  | "broadcast-response";

export type ModbusExchange =
  | { status: "matched" | "broadcast" | "missing-response" }
  | { status: "device-exception"; exceptionCode: number }
  | { status: "mismatch"; reason: MismatchReason };

export function modbusUnitRouting(
  transport: ModbusTransport,
  value: unknown,
): ModbusUnitRouting {
  if (value === undefined) return "gateway";
  if (transport === "tcp" && (value === "gateway" || value === "direct"))
    return value;
  throw new ProtocolFieldError("unitRouting", "Expected TCP gateway or direct");
}

function decodeSample(
  transport: ModbusTransport,
  direction: ModbusDirection,
  bytes: Uint8Array,
) {
  try {
    return decodeModbusFrame(transport, direction, bytes);
  } catch (error) {
    if (error instanceof ProtocolFieldError)
      throw new ProtocolFieldError(`${direction}.${error.path}`, error.message);
    throw error;
  }
}

function mismatch(reason: MismatchReason): ModbusExchange {
  return { status: "mismatch", reason };
}

export function compareModbusExchange(
  transport: ModbusTransport,
  requestBytes: Uint8Array,
  responseBytes?: Uint8Array,
  unitRouting: ModbusUnitRouting = "gateway",
): ModbusExchange {
  const sent = decodeSample(transport, "request", requestBytes);
  if (sent.broadcast)
    return responseBytes
      ? mismatch("broadcast-response")
      : { status: "broadcast" };
  if (!responseBytes) return { status: "missing-response" };

  const request = sent.packet;
  const response = decodeSample(transport, "response", responseBytes).packet;
  if (
    "transactionId" in request &&
    "transactionId" in response &&
    request.transactionId !== response.transactionId
  )
    return mismatch("transaction-id");
  if (
    (transport !== "tcp" || unitRouting === "gateway") &&
    request.unitId !== response.unitId
  )
    return mismatch("unit-id");

  const sentPdu = request.pdu;
  const receivedPdu = response.pdu;
  if (sentPdu.functionCode !== receivedPdu.functionCode)
    return mismatch("function-code");
  if ("exceptionCode" in receivedPdu)
    return {
      status: "device-exception",
      exceptionCode: receivedPdu.exceptionCode,
    };

  if ("bitBytes" in receivedPdu && "quantity" in sentPdu) {
    const { bitBytes } = receivedPdu;
    if (bitBytes.length !== Math.ceil(sentPdu.quantity / 8))
      return mismatch("read-count");
    const usedBits = sentPdu.quantity % 8;
    if (usedBits !== 0 && bitBytes.at(-1)! >>> usedBits)
      return mismatch("padding");
  }
  if (
    "values" in receivedPdu &&
    "quantity" in sentPdu &&
    receivedPdu.values.length !== sentPdu.quantity
  )
    return mismatch("read-count");
  if (
    "address" in receivedPdu &&
    "address" in sentPdu &&
    receivedPdu.address !== sentPdu.address
  )
    return mismatch("write-address");
  if (
    "value" in receivedPdu &&
    "value" in sentPdu &&
    receivedPdu.value !== sentPdu.value
  )
    return mismatch("write-echo");
  if (
    "quantity" in receivedPdu &&
    "values" in sentPdu &&
    receivedPdu.quantity !== sentPdu.values.length
  )
    return mismatch("write-count");
  return { status: "matched" };
}
