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
import {
  compareSessionFrames,
  type ComparisonFrame,
  type FrameAlignment,
} from "./session-comparison.ts";

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
    signal: AbortSignal,
  ) => ReturnType<NodeActionHandler>,
): NodeActionHandler {
  return async ({ params }, { signal }) => {
    signal.throwIfAborted();
    try {
      const result = await run(params, signal);
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

function comparisonObject(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProtocolFieldError(path, "Expected an object");
  return value as Record<string, unknown>;
}

function comparisonCount(value: unknown, path: string, limit: number) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > limit
  )
    throw new ProtocolFieldError(path, "Expected a bounded integer");
  return value;
}

function comparisonU64(value: unknown, path: string) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > 18_446_744_073_709_551_615n
  )
    throw new ProtocolFieldError(path, "Expected a decimal U64");
  return BigInt(value);
}

function comparisonFrames(
  input: unknown,
  path: string,
  signal: AbortSignal,
): ComparisonFrame[] {
  if (!Array.isArray(input) || input.length > 128)
    throw new ProtocolFieldError(path, "Expected at most 128 frames");
  let last = 0n;
  let bytes = 0;
  return input.map((item, index) => {
    signal.throwIfAborted();
    const name = path + "[" + index + "]";
    const frame = comparisonObject(item, name);
    const position = comparisonU64(frame.position, name + ".position");
    if (position <= last)
      throw new ProtocolFieldError(
        name + ".position",
        "Expected an increasing frame position",
      );
    last = position;
    const data = decodeBytes(frame.bytesBase64, name + ".bytesBase64");
    bytes += data.length;
    if (data.length > 4096 || bytes > 65_536)
      throw new ProtocolFieldError(
        path,
        "Frame bytes exceed the accepted window",
      );
    if (frame.time === undefined) return { position, bytes: data };
    const time = comparisonObject(frame.time, name + ".time");
    const id = time.clockId;
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id)
    )
      throw new ProtocolFieldError(name + ".time.clockId", "Invalid clock ID");
    return {
      position,
      bytes: data,
      time: {
        clockId: id,
        monoNs: comparisonU64(time.monoNs, name + ".time.monoNs"),
        segment: comparisonCount(
          time.segment,
          name + ".time.segment",
          2_147_483_647,
        ),
      },
    };
  });
}

function comparisonAlignment(value: unknown): FrameAlignment {
  const key = comparisonObject(value, "alignment");
  if (key.kind === "ordinal") return { kind: key.kind };
  if (key.kind === "prefix") {
    const length = comparisonCount(key.length, "alignment.length", 32);
    if (length === 0)
      throw new ProtocolFieldError("alignment.length", "Prefix is empty");
    return { kind: key.kind, length };
  }
  const ids: unknown = key.ids;
  if (
    key.kind === "fields" &&
    Array.isArray(ids) &&
    ids.length >= 1 &&
    ids.length <= 4 &&
    ids.every(
      (id): id is string =>
        typeof id === "string" && id.length > 0 && id.length <= 64,
    ) &&
    new Set(ids).size === ids.length
  )
    return { kind: key.kind, ids };
  throw new ProtocolFieldError(
    "alignment",
    "Choose frame position, a byte prefix, or one to four field IDs",
  );
}

const compareSessions = fieldAction(
  (
    { baseline, candidate, alignment, definition, definitionFormat, detail },
    signal,
  ): QueryValue => {
    const key = comparisonAlignment(alignment);
    if (key.kind === "fields" && definition === undefined)
      throw new ProtocolFieldError(
        "definition",
        "Field alignment requires a definition",
      );
    if (definition === undefined && definitionFormat !== undefined)
      throw new ProtocolFieldError(
        "definitionFormat",
        "Definition format requires a definition",
      );
    const rows = compareSessionFrames(
      comparisonFrames(baseline, "baseline", signal),
      comparisonFrames(candidate, "candidate", signal),
      key,
      definition === undefined
        ? undefined
        : codec(definition, definitionFormat),
      signal,
    );
    const summary = rows.map((row) => ({
      baselinePosition: row.left?.position.toString() ?? null,
      candidatePosition: row.right?.position.toString() ?? null,
      keyAvailable: row.keyAvailable,
      repeatedKey: row.repeatedKey,
      changedBytes: row.bytes?.count ?? null,
      changedFields: row.fields?.length ?? null,
      elapsedDeltaNs: row.elapsedDeltaNs?.toString() ?? null,
      baselineDecodeFailure: row.left?.decodeFailure?.slice(0, 120) ?? null,
      candidateDecodeFailure: row.right?.decodeFailure?.slice(0, 120) ?? null,
    }));
    if (detail === undefined) return { status: "compared", rows: summary };
    const selection = comparisonObject(detail, "detail");
    const index = comparisonCount(selection.rowIndex, "detail.rowIndex", 255);
    const row = rows[index];
    if (!row)
      throw new ProtocolFieldError(
        "detail.rowIndex",
        "Comparison row is not present",
      );
    const byteOffset = comparisonCount(
      selection.byteOffset ?? 0,
      "detail.byteOffset",
      2048,
    );
    const fieldOffset = comparisonCount(
      selection.fieldOffset ?? 0,
      "detail.fieldOffset",
      128,
    );
    return {
      status: "compared",
      rows: summary,
      detail: {
        rowIndex: index,
        byteRanges: row.bytes
          ? {
              offset: byteOffset,
              total: row.bytes.ranges.length,
              items: row.bytes.ranges.slice(byteOffset, byteOffset + 128),
            }
          : null,
        fields: row.fields
          ? {
              offset: fieldOffset,
              total: row.fields.length,
              items: row.fields
                .slice(fieldOffset, fieldOffset + 4)
                .map(({ id, left, right }) => ({
                  id,
                  baseline: {
                    value: left.value,
                    rawHex: left.rawHex,
                    rawValue: left.rawValue ?? null,
                  },
                  candidate: {
                    value: right.value,
                    rawHex: right.rawHex,
                    rawValue: right.rawValue ?? null,
                  },
                })),
            }
          : null,
      },
    };
  },
);

export const register: NodeRegister = ({ parsers }) => {
  parsers.register("swb.reference.fields.decode", decode);
  parsers.register("swb.reference.fields.encode", encode);
  parsers.register("swb.reference.fields.identifyCrc", identifyCrc);
  parsers.register("swb.reference.fields.modbus", modbus);
  parsers.register("swb.reference.fields.modbusServer", modbusServer);
  parsers.register("swb.reference.fields.nmea", nmea);
  parsers.register("swb.reference.fields.at", atResponse);
  parsers.register("swb.reference.fields.compareSessions", compareSessions);
  return () => {};
};
