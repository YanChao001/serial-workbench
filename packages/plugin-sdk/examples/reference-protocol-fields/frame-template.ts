import { formatHex, HexInputError, parseHex } from "../../src/hex.ts";
import {
  CHECKSUM_WIDTHS,
  checksumBytes,
  type ChecksumAlgorithm,
  type ChecksumOrder,
} from "../../src/wire-checksum.ts";
import {
  compileProtocolFields,
  ProtocolFieldError,
} from "../reference-framing/protocol-fields.ts";

export const frameTemplateWidths = [1, 2, 4, 8] as const;
export const frameLengthCoverage = [
  "payload",
  "sequence-payload",
  "frame",
] as const;
export const frameChecksumCoverage = [
  "payload",
  "sequence-payload",
  "length-payload",
  "header-payload",
] as const;
export const frameTemplateParts = [
  "header",
  "length",
  "sequence",
  "payload",
  "checksum",
  "tail",
] as const;

const maxFrameBytes = 4096;
const byteOrders = ["big", "little"] as const;
const payloadFormats = ["hex", "utf8"] as const;
type Part = (typeof frameTemplateParts)[number];
type Numeric = {
  width: (typeof frameTemplateWidths)[number];
  order: ChecksumOrder;
};
type Range = { start: number; end: number };

export type FrameTemplate = {
  version: "1";
  headerHex: string;
  length: Numeric & { coverage: (typeof frameLengthCoverage)[number] };
  sequence: Numeric & { variable: string };
  payload: { variable: string; format: (typeof payloadFormats)[number] };
  checksum: {
    algorithm: ChecksumAlgorithm;
    order: ChecksumOrder;
    coverage: (typeof frameChecksumCoverage)[number];
  };
  tailHex: string;
};

export const defaultFrameTemplate: FrameTemplate = {
  version: "1",
  headerHex: "AA 55",
  length: { width: 1, order: "big", coverage: "payload" },
  sequence: { width: 2, order: "little", variable: "serial" },
  payload: { variable: "data", format: "hex" },
  checksum: {
    algorithm: "xor",
    order: "big",
    coverage: "sequence-payload",
  },
  tailHex: "0D",
};

export type FrameTemplateResult = {
  bytes: Uint8Array<ArrayBuffer>;
  values: Readonly<Record<string, string>>;
  parts: {
    id: Part;
    range: Range;
    hex: string;
    value: string;
    variable?: string;
    coverage?: Range;
  }[];
};

function invalid(path: string, reason: string): never {
  throw new ProtocolFieldError(path, reason);
}

function object(
  input: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return invalid(path, "Expected an object");
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    return invalid(path, "Expected a plain object");
  if (Object.keys(input).some((key) => !keys.includes(key)))
    return invalid(path, "Unexpected property");
  return input as Record<string, unknown>;
}

function oneOf<T extends string | number>(
  input: unknown,
  options: readonly T[],
  path: string,
): T {
  return (
    options.find((option) => option === input) ??
    invalid(path, "Unsupported option")
  );
}

function variable(input: unknown, path: string): string {
  if (typeof input !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(input))
    return invalid(path, "Expected a variable name");
  return input;
}

function hex(input: unknown, path: string) {
  if (typeof input !== "string" || input.length > maxFrameBytes * 3)
    return invalid(path, "Expected bounded hexadecimal bytes");
  try {
    return parseHex(input);
  } catch (error) {
    if (error instanceof HexInputError) return invalid(path, "Invalid HEX");
    throw error;
  }
}

function numeric(input: Record<string, unknown>, path: string): Numeric {
  return {
    width: oneOf(input.width, frameTemplateWidths, `${path}.width`),
    order: oneOf(input.order, byteOrders, `${path}.order`),
  };
}

export function parseFrameTemplate(input: unknown): FrameTemplate {
  const template = object(
    input,
    [
      "version",
      "headerHex",
      "length",
      "sequence",
      "payload",
      "checksum",
      "tailHex",
    ],
    "template",
  );
  const version = oneOf(template.version, ["1"] as const, "version");
  const length = object(
    template.length,
    ["width", "order", "coverage"],
    "length",
  );
  const sequence = object(
    template.sequence,
    ["width", "order", "variable"],
    "sequence",
  );
  const payload = object(template.payload, ["variable", "format"], "payload");
  const checksum = object(
    template.checksum,
    ["algorithm", "order", "coverage"],
    "checksum",
  );
  const sequenceVariable = variable(sequence.variable, "sequence.variable");
  const payloadVariable = variable(payload.variable, "payload.variable");
  if (sequenceVariable === payloadVariable)
    return invalid(
      "payload.variable",
      "Sequence and payload need distinct variables",
    );
  return {
    version,
    headerHex: formatHex(hex(template.headerHex, "headerHex")),
    length: {
      ...numeric(length, "length"),
      coverage: oneOf(length.coverage, frameLengthCoverage, "length.coverage"),
    },
    sequence: { ...numeric(sequence, "sequence"), variable: sequenceVariable },
    payload: {
      variable: payloadVariable,
      format: oneOf(payload.format, payloadFormats, "payload.format"),
    },
    checksum: {
      algorithm: oneOf(
        checksum.algorithm,
        Object.keys(CHECKSUM_WIDTHS) as ChecksumAlgorithm[],
        "checksum.algorithm",
      ),
      order: oneOf(checksum.order, byteOrders, "checksum.order"),
      coverage: oneOf(
        checksum.coverage,
        frameChecksumCoverage,
        "checksum.coverage",
      ),
    },
    tailHex: formatHex(hex(template.tailHex, "tailHex")),
  };
}

function compact(text: string) {
  return text.replaceAll(" ", "");
}

export function compileFrameTemplate(input: unknown) {
  const definition = parseFrameTemplate(input);
  const { headerHex, length, sequence, payload, checksum, tailHex } =
    definition;
  const widths = {
    header: hex(headerHex, "headerHex").length,
    length: length.width,
    sequence: sequence.width,
    checksum: CHECKSUM_WIDTHS[checksum.algorithm],
    tail: hex(tailHex, "tailHex").length,
  };
  const fixed = Object.values(widths).reduce(
    (total, width) => total + width,
    0,
  );
  if (fixed > maxFrameBytes) invalid("frame", "Fixed fields exceed 4096 bytes");
  const names = [sequence.variable, payload.variable];

  function layout(payloadWidth: number) {
    const byteLength = fixed + payloadWidth;
    if (payloadWidth < 0 || byteLength > maxFrameBytes)
      return invalid("frame", "Frame is outside the allowed byte range");

    const sizes = { ...widths, payload: payloadWidth };
    let offset = 0;
    const ranges = new Map(
      frameTemplateParts.map((part) => {
        const start = offset;
        offset += sizes[part];
        return [part, { start, end: offset }] as const;
      }),
    );
    function at(part: Part): Range {
      const range = ranges.get(part);
      if (!range) return invalid("frame", "Missing field range");
      return range;
    }

    const payloadEnd = at("payload").end;
    const lengthRange =
      length.coverage === "frame"
        ? { start: 0, end: byteLength }
        : {
            start: at(length.coverage === "payload" ? "payload" : "sequence")
              .start,
            end: payloadEnd,
          };
    const checksumFirst = {
      payload: "payload",
      "sequence-payload": "sequence",
      "length-payload": "length",
      "header-payload": "header",
    } as const;
    const checksumRange = {
      start: at(checksumFirst[checksum.coverage]).start,
      end: payloadEnd,
    };
    const lengthValue = String(lengthRange.end - lengthRange.start);
    if (BigInt(lengthValue) >= 1n << BigInt(length.width * 8))
      return invalid(
        "length.width",
        "Computed length exceeds the selected width",
      );

    const fields = frameTemplateParts.flatMap((id) => {
      if (id === "checksum" || sizes[id] === 0) return [];
      const base = { id, width: sizes[id], byteOffset: at(id).start };
      if (id === "length" || id === "sequence")
        return [{ ...base, kind: "integer", order: definition[id].order }];
      return [
        {
          ...base,
          kind:
            id === "payload" && payload.format === "utf8" ? "utf8" : "bytes",
        },
      ];
    });
    const codec = compileProtocolFields({ version: "1", byteLength, fields });
    return { at, sizes, codec, lengthValue, lengthRange, checksumRange };
  }

  function calculate(frame: Uint8Array, coverage: Range) {
    return checksumBytes(
      frame.subarray(coverage.start, coverage.end),
      checksum.algorithm,
      checksum.order,
    );
  }

  function decode(input: Uint8Array): FrameTemplateResult {
    const resolved = layout(input.length - fixed);
    const { at, codec, lengthValue, lengthRange, checksumRange } = resolved;
    const fieldHex = (id: Part) =>
      formatHex(input.subarray(at(id).start, at(id).end));
    if (fieldHex("header") !== headerHex)
      return invalid("headerHex", "Frame header differs");
    if (fieldHex("tail") !== tailHex)
      return invalid("tailHex", "Frame tail differs");
    const readings = new Map(
      codec.decode(input).map((entry) => [entry.id, entry.value]),
    );
    if (readings.get("length") !== lengthValue)
      return invalid(
        "length",
        "Declared length differs from the complete frame",
      );
    if (fieldHex("checksum") !== formatHex(calculate(input, checksumRange)))
      return invalid("checksum", "Checksum does not match the covered bytes");
    const sequenceValue =
      readings.get("sequence") ?? invalid("sequence", "Missing sequence");
    const payloadValue =
      payload.format === "hex"
        ? fieldHex("payload")
        : (readings.get("payload") ?? "");
    const values = {
      [sequence.variable]: sequenceValue,
      [payload.variable]: payloadValue,
    };
    return {
      bytes: Uint8Array.from(input),
      values,
      parts: frameTemplateParts.map((id) => ({
        id,
        range: at(id),
        hex: fieldHex(id),
        value:
          id === "sequence"
            ? sequenceValue
            : id === "payload"
              ? payloadValue
              : (readings.get(id) ?? fieldHex(id)),
        ...(id === "length" && { coverage: lengthRange }),
        ...(id === "checksum" && { coverage: checksumRange }),
        ...(id === "sequence" && { variable: sequence.variable }),
        ...(id === "payload" && { variable: payload.variable }),
      })),
    };
  }

  return {
    definition,
    assemble(input: unknown): FrameTemplateResult {
      const values = object(input, names, "values");
      const sequenceValue = values[sequence.variable];
      const payloadValue = values[payload.variable];
      if (
        typeof sequenceValue !== "string" ||
        !/^(0|[1-9]\d{0,19})$/.test(sequenceValue)
      )
        return invalid(
          "values.sequence",
          "Expected an unsigned integer string",
        );
      if (
        typeof payloadValue !== "string" ||
        payloadValue.length > maxFrameBytes * (payload.format === "hex" ? 3 : 1)
      )
        return invalid("values.payload", "Expected a bounded payload string");
      const payloadBytes =
        payload.format === "hex"
          ? hex(payloadValue, "values.payload")
          : new TextEncoder().encode(payloadValue);
      const { codec, at, sizes, lengthValue, checksumRange } = layout(
        payloadBytes.length,
      );
      const frame = codec.encode({
        ...(sizes.header > 0 && { header: compact(headerHex) }),
        length: lengthValue,
        sequence: sequenceValue,
        ...(sizes.payload > 0 && {
          payload:
            payload.format === "hex"
              ? compact(formatHex(payloadBytes))
              : payloadValue,
        }),
        ...(sizes.tail > 0 && { tail: compact(tailHex) }),
      });
      frame.set(calculate(frame, checksumRange), at("checksum").start);
      return decode(frame);
    },
    decode,
  };
}
