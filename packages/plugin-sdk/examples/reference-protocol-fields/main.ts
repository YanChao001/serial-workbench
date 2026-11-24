import type {
  NodeActionHandler,
  NodeRegister,
} from "@serial-workbench/plugin-sdk/node";
import type { QueryValue } from "@serial-workbench/contracts";
import {
  compileProtocolFieldDocument,
  maxDefinitionLength,
  ProtocolDefinitionError,
} from "../reference-framing/protocol-field-document.ts";
import { ProtocolFieldError } from "../reference-framing/protocol-fields.ts";
import { maxCrcSamples, recognizeCrc } from "./crc-recognition.ts";
import { compareModbusExchange, modbusUnitRouting } from "./modbus-exchange.ts";
import {
  decodeModbusFrame,
  encodeModbusFrame,
  modbusDirection,
  modbusTransport,
} from "./modbus-frame.ts";
import { simulateModbusServer } from "./modbus-server.ts";
import { parseNmeaText } from "./nmea.ts";
import { parseAtResponse } from "./at-response.ts";

function codec(definition: unknown, format: unknown) {
  if (
    typeof definition !== "string" ||
    definition.length > maxDefinitionLength
  ) {
    throw new ProtocolFieldError(
      "definition",
      "Expected a bounded protocol definition",
    );
  }
  if (format !== undefined && format !== "json" && format !== "yaml")
    throw new ProtocolFieldError("definitionFormat", "Expected json or yaml");
  return compileProtocolFieldDocument(definition, format ?? "json").codec;
}

function decodeBytes(value: unknown, path: string) {
  if (typeof value === "string" && value.length <= 5464) {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length > 0 && bytes.toString("base64") === value) return bytes;
  }
  throw new ProtocolFieldError(path, "Invalid base64 bytes");
}

function fieldAction(
  run: (
    params: Parameters<NodeActionHandler>[0]["params"],
  ) => ReturnType<NodeActionHandler>,
): NodeActionHandler {
  return async ({ params }, { signal }) => {
    signal.throwIfAborted();
    try {
      const result = await run(params);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ProtocolFieldError)) throw error;
      return {
        status: "invalid",
        path: error.path.slice(0, 120),
        ...(error instanceof ProtocolDefinitionError
          ? { position: error.position }
          : {}),
      };
    }
  };
}

const decode = fieldAction(({ definition, definitionFormat, bytesBase64 }) => ({
  status: "decoded",
  readings: codec(definition, definitionFormat).decode(
    decodeBytes(bytesBase64, "bytesBase64"),
  ),
}));

const encode = fieldAction(
  ({ definition, definitionFormat, values, baseBytesBase64 }) => ({
    status: "encoded",
    bytesBase64: Buffer.from(
      codec(definition, definitionFormat).encode(
        values,
        baseBytesBase64 === undefined
          ? undefined
          : decodeBytes(baseBytesBase64, "baseBytesBase64"),
      ),
    ).toString("base64"),
  }),
);

const identifyCrc = fieldAction(({ samples, width, order }) => {
  if (
    !Array.isArray(samples) ||
    samples.length === 0 ||
    samples.length > maxCrcSamples
  )
    throw new ProtocolFieldError("samples", "Expected a bounded sample array");
  if (width !== undefined && typeof width !== "number")
    throw new ProtocolFieldError("width", "Expected a CRC width");
  if (
    order !== undefined &&
    order !== "auto" &&
    order !== "big" &&
    order !== "little"
  )
    throw new ProtocolFieldError(
      "order",
      "Expected auto, big or little endian",
    );
  const inputs: readonly unknown[] = samples;
  return recognizeCrc(
    inputs.map((sample, index) => {
      if (
        typeof sample !== "object" ||
        sample === null ||
        !("bytesBase64" in sample) ||
        !("checksumBase64" in sample)
      )
        throw new ProtocolFieldError(
          `samples[${index}]`,
          "Expected sample bytes and checksum",
        );
      return {
        bytes: decodeBytes(sample.bytesBase64, `samples[${index}].bytesBase64`),
        checksum: decodeBytes(
          sample.checksumBase64,
          `samples[${index}].checksumBase64`,
        ),
      };
    }),
    { width, order },
  );
});

const modbus = fieldAction(
  ({
    mode,
    transport,
    direction,
    packet,
    bytesBase64,
    requestBase64,
    responseBase64,
    unitRouting,
  }): QueryValue => {
    const selectedTransport = modbusTransport(transport);
    if (mode === "compare")
      return compareModbusExchange(
        selectedTransport,
        decodeBytes(requestBase64, "requestBase64"),
        responseBase64 === undefined
          ? undefined
          : decodeBytes(responseBase64, "responseBase64"),
        modbusUnitRouting(selectedTransport, unitRouting),
      );
    const selectedDirection = modbusDirection(direction);
    if (mode === "encode")
      return {
        status: "encoded",
        bytesBase64: Buffer.from(
          encodeModbusFrame(selectedTransport, selectedDirection, packet),
        ).toString("base64"),
      };
    if (mode === "decode")
      return {
        status: "decoded",
        ...decodeModbusFrame(
          selectedTransport,
          selectedDirection,
          decodeBytes(bytesBase64, "bytesBase64"),
        ),
      };
    throw new ProtocolFieldError("mode", "Expected encode, decode or compare");
  },
);

const modbusServer = fieldAction(
  ({ transport, requestBase64, model, unitRouting }): QueryValue => {
    const selected = modbusTransport(transport);
    const result = simulateModbusServer(
      selected,
      decodeBytes(requestBase64, "requestBase64"),
      model,
      modbusUnitRouting(selected, unitRouting),
    );
    if ("responseBytes" in result) {
      const { responseBytes, ...report } = result;
      return {
        ...report,
        responseBase64: Buffer.from(responseBytes).toString("base64"),
      };
    }
    return result;
  },
);

const nmea = fieldAction(({ text }): QueryValue => parseNmeaText(text));
const atResponse = fieldAction(({ text, command, format }): QueryValue =>
  parseAtResponse(text, command, format),
);

export const register: NodeRegister = ({ parsers }) => {
  parsers.register("swb.reference.fields.decode", decode);
  parsers.register("swb.reference.fields.encode", encode);
  parsers.register("swb.reference.fields.identifyCrc", identifyCrc);
  parsers.register("swb.reference.fields.modbus", modbus);
  parsers.register("swb.reference.fields.modbusServer", modbusServer);
  parsers.register("swb.reference.fields.nmea", nmea);
  parsers.register("swb.reference.fields.at", atResponse);
  return () => {};
};
