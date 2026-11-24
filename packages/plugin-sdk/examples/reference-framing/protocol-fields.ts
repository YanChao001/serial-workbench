import {
  CHECKSUM_WIDTHS,
  checksumBytes,
  type ChecksumAlgorithm,
  type ChecksumOrder,
} from "../../src/wire-checksum.ts";
import {
  absolute,
  calibrate,
  uncalibrate,
  type CalibrationPoint,
  type CalibrationTable,
} from "./calibration-table.ts";

const maxFrameBytes = 4096;
const maxFields = 128;
const precision = 18;
const decimalUnit = 10n ** BigInt(precision);

type Range = { start: number; end: number };
type FieldBase = { id: string; bytes: Range; unit?: string };
type Calibration = { kind: "linear" | "table"; revision: string };
type Numeric = { scale: bigint; bias: bigint; calibration?: Calibration };
type IntegerField = FieldBase &
  Numeric & {
    kind: "integer" | "bits";
    order: ChecksumOrder;
    signed: boolean;
    bitOffset: number;
    bitLength: number;
    labels: ReadonlyMap<bigint, string>;
    table?: CalibrationTable;
  };
type FloatField = FieldBase & Numeric & { kind: "float"; order: ChecksumOrder };
type DataField = FieldBase & { kind: "bytes" | "utf8" };
type ChecksumField = FieldBase & {
  kind: "checksum";
  order: ChecksumOrder;
  coverage: Range;
  algorithm: ChecksumAlgorithm;
};
type Field = IntegerField | FloatField | DataField | ChecksumField;

export type FieldReading = FieldBase & {
  kind: Field["kind"];
  rawHex: string;
  value: string;
  rawValue?: string;
  calibration?: Calibration & { status: "applied" | "unmapped" };
  label?: string;
  bits?: Range;
  checksum?: { coverage: Range; expectedHex: string; valid: boolean };
};

export class ProtocolFieldError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "ProtocolFieldError";
    this.path = path;
  }
}

function invalid(path: string, detail: string): never {
  throw new ProtocolFieldError(path, detail);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid(path, "Expected an object");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return invalid(path, "Expected a plain object");
  return value as Record<string, unknown>;
}

function bounded(value: unknown, min: number, max: number, path: string) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    return invalid(path, `Expected an integer from ${min} to ${max}`);
  return value;
}

function order(value: unknown, path: string): ChecksumOrder {
  if (value === "little" || value === "big") return value;
  return invalid(path, "Expected little or big endian");
}

function only(object: Record<string, unknown>, keys: string[], path: string) {
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) invalid(`${path}.${key}`, "Unknown property");
  }
}

function fixed(value: unknown, path: string, maxWholeDigits = 40): bigint {
  if (
    typeof value !== "string" ||
    value.length > maxWholeDigits + precision + 2 ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)
  )
    return invalid(
      path,
      "Expected a decimal string with up to 18 decimal places",
    );
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (
    negative ? value.slice(1) : value
  ).split(".");
  if (whole.length > maxWholeDigits)
    invalid(path, "Decimal magnitude is too large");
  const coefficient = BigInt(whole + fraction.padEnd(precision, "0"));
  return negative ? -coefficient : coefficient;
}

function decimal(value: bigint) {
  const magnitude = value < 0n ? -value : value;
  const whole = magnitude / decimalUnit;
  const fraction = (magnitude % decimalUnit)
    .toString()
    .padStart(precision, "0")
    .replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${whole}${fraction ? "." + fraction : ""}`;
}

function integerLimits(bits: number, signed: boolean) {
  const half = 1n << BigInt(bits - Number(signed));
  return { min: signed ? -half : 0n, max: half - 1n };
}

function calibrationProfile(input: Record<string, unknown>, path: string) {
  if (input.calibration === undefined)
    return {
      scale:
        input.scale === undefined
          ? decimalUnit
          : fixed(input.scale, `${path}.scale`),
      bias: input.bias === undefined ? 0n : fixed(input.bias, `${path}.bias`),
    };
  if (input.scale !== undefined || input.bias !== undefined)
    invalid(`${path}.calibration`, "Use one calibration definition per field");
  const location = `${path}.calibration`;
  const config = record(input.calibration, location);
  const { kind, revision } = config;
  if (
    typeof revision !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(revision)
  )
    return invalid(
      `${location}.revision`,
      "Expected a calibration revision identifier",
    );
  if (kind === "linear") {
    only(config, ["kind", "revision", "scale", "bias"], location);
    const scale = fixed(config.scale, `${location}.scale`);
    if (scale === 0n) invalid(`${location}.scale`, "Scale must be nonzero");
    return {
      scale,
      bias:
        config.bias === undefined ? 0n : fixed(config.bias, `${location}.bias`),
      calibration: { kind, revision },
    } as const;
  }
  if (kind !== "table")
    return invalid(`${location}.kind`, "Unknown calibration method");
  only(config, ["kind", "revision", "points", "interpolation"], location);
  return {
    scale: decimalUnit,
    bias: 0n,
    calibration: { kind, revision },
    table: config,
  } as const;
}

function parseCalibrationTable(
  config: Record<string, unknown>,
  bits: number,
  signed: boolean,
  path: string,
): CalibrationTable {
  const { points, interpolation = "exact" } = config;
  if (interpolation !== "exact" && interpolation !== "linear")
    return invalid(`${path}.interpolation`, "Expected exact or linear");
  if (
    !Array.isArray(points) ||
    points.length < (interpolation === "linear" ? 2 : 1) ||
    points.length > 128
  )
    return invalid(`${path}.points`, "Invalid calibration table size");
  const { min, max } = integerLimits(bits, signed);
  const result: CalibrationPoint[] = [];
  const used = new Set<bigint>();
  let direction: boolean | undefined;
  for (const [index, point] of (points as unknown[]).entries()) {
    const location = `${path}.points[${index}]`;
    const sample = record(point, location);
    only(sample, ["raw", "value"], location);
    if (
      typeof sample.raw !== "string" ||
      !/^-?(?:0|[1-9]\d{0,19})$/.test(sample.raw)
    )
      invalid(`${location}.raw`, "Expected a decimal raw integer string");
    const raw = BigInt(sample.raw);
    const value = fixed(sample.value, `${location}.value`);
    const previous = result.at(-1);
    if (raw < min || raw > max || (previous && raw <= previous.raw))
      invalid(
        `${location}.raw`,
        "Raw codes must increase within the field range",
      );
    if (used.has(value))
      invalid(`${location}.value`, "Calibrated values must be unique");
    if (previous && interpolation === "linear") {
      const increase = value > previous.value;
      if (
        (direction !== undefined && increase !== direction) ||
        absolute(value - previous.value) < raw - previous.raw
      )
        invalid(
          `${location}.value`,
          "Interpolated values must be monotone and separately represent every raw code",
        );
      direction = increase;
    }
    used.add(value);
    result.push({ raw, value });
  }
  return { points: result, interpolation };
}

function parseLabels(
  value: unknown,
  bits: number,
  signed: boolean,
  path: string,
) {
  const labels = new Map<bigint, string>();
  if (value === undefined) return labels;
  const entries = Object.entries(record(value, path));
  if (entries.length > 128) invalid(path, "Too many enum values");
  const { min, max } = integerLimits(bits, signed);
  for (const [key, label] of entries) {
    if (!/^(?:0|-?[1-9]\d{0,19})$/.test(key))
      invalid(`${path}.${key}`, "Expected a canonical raw integer");
    const number = BigInt(key);
    if (
      number < min ||
      number > max ||
      typeof label !== "string" ||
      !label.trim() ||
      label.length > 80
    )
      invalid(
        `${path}.${key}`,
        "Enum entry is outside the field range or has an invalid label",
      );
    labels.set(number, label);
  }
  return labels;
}

function parseField(raw: unknown, frameLength: number, index: number): Field {
  const path = `fields[${index}]`;
  const input = record(raw, path);
  const { id, kind, unit } = input;
  if (typeof id !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(id))
    return invalid(`${path}.id`, "Invalid field identifier");
  if (unit !== undefined && (typeof unit !== "string" || unit.length > 24))
    return invalid(`${path}.unit`, "Expected a short unit label");
  const start = bounded(
    input.byteOffset,
    0,
    frameLength - 1,
    `${path}.byteOffset`,
  );
  const common = ["id", "kind", "unit", "byteOffset"];
  if (kind === "checksum") {
    only(
      input,
      [...common, "algorithm", "order", "coverageStart", "coverageEnd"],
      path,
    );
    const algorithm = input.algorithm;
    if (
      typeof algorithm !== "string" ||
      !Object.hasOwn(CHECKSUM_WIDTHS, algorithm)
    )
      return invalid(`${path}.algorithm`, "Unknown checksum algorithm");
    const known = algorithm as ChecksumAlgorithm;
    const end = start + CHECKSUM_WIDTHS[known];
    if (end > frameLength) invalid(path, "Checksum position exceeds the frame");
    const coverageStart = bounded(
      input.coverageStart,
      0,
      frameLength - 1,
      `${path}.coverageStart`,
    );
    const coverageEnd = bounded(
      input.coverageEnd,
      coverageStart + 1,
      frameLength,
      `${path}.coverageEnd`,
    );
    return {
      id,
      kind,
      unit,
      bytes: { start, end },
      algorithm: known,
      order: order(input.order, `${path}.order`),
      coverage: { start: coverageStart, end: coverageEnd },
    };
  }
  const width = bounded(input.width, 1, frameLength - start, `${path}.width`);
  const base = { id, unit, bytes: { start, end: start + width } };
  if (kind === "bytes" || kind === "utf8") {
    only(input, [...common, "width"], path);
    return { ...base, kind };
  }
  if (kind !== "integer" && kind !== "bits" && kind !== "float")
    return invalid(`${path}.kind`, "Unknown field type");
  const numeric = [...common, "width", "order", "scale", "bias", "calibration"];
  const { scale, bias, calibration, table } = calibrationProfile(input, path);
  if (scale === 0n) invalid(`${path}.scale`, "Scale must be nonzero");
  const byteOrder = order(input.order, `${path}.order`);
  if (kind === "float") {
    only(input, numeric, path);
    if (width !== 4 && width !== 8)
      invalid(`${path}.width`, "Expected a 4- or 8-byte float");
    if (table)
      invalid(
        `${path}.calibration.kind`,
        "Table calibration requires raw integer codes",
      );
    return { ...base, kind, order: byteOrder, scale, bias, calibration };
  }
  only(
    input,
    [
      ...numeric,
      "signed",
      "labels",
      ...(kind === "bits" ? ["bitOffset", "bitLength"] : []),
    ],
    path,
  );
  if (width > 8)
    invalid(`${path}.width`, "Integer fields can use at most 8 bytes");
  if (input.signed !== undefined && typeof input.signed !== "boolean")
    invalid(`${path}.signed`, "Expected a boolean");
  const signed = input.signed === true;
  const bitOffset =
    kind === "bits"
      ? bounded(input.bitOffset, 0, width * 8 - 1, `${path}.bitOffset`)
      : 0;
  const bitLength =
    kind === "bits"
      ? bounded(input.bitLength, 1, width * 8 - bitOffset, `${path}.bitLength`)
      : width * 8;
  const labels = parseLabels(input.labels, bitLength, signed, `${path}.labels`);
  return {
    ...base,
    kind,
    order: byteOrder,
    scale,
    bias,
    calibration,
    table:
      table &&
      parseCalibrationTable(table, bitLength, signed, `${path}.calibration`),
    signed,
    bitOffset,
    bitLength,
    labels,
  };
}

function validateNonoverlapping(fields: Field[], byteLength: number) {
  const used = new Uint8Array(byteLength);
  function occupy(byte: number, mask: number, id: string) {
    const previous = used[byte] ?? 0;
    if (previous & mask) invalid(`fields.${id}`, "Overlapping field bits");
    used[byte] = previous | mask;
  }
  for (const field of fields) {
    const { start, end } = field.bytes;
    if (field.kind !== "bits") {
      for (let byte = start; byte < end; byte++) occupy(byte, 255, field.id);
      continue;
    }
    for (
      let bit = field.bitOffset;
      bit < field.bitOffset + field.bitLength;
      bit++
    ) {
      const byte = Math.floor(bit / 8);
      occupy(
        field.order === "little" ? start + byte : end - 1 - byte,
        1 << (bit % 8),
        field.id,
      );
    }
  }
}

function checksumOrder(fields: Field[]) {
  const pending = fields.filter((field) => field.kind === "checksum");
  const ordered: ChecksumField[] = [];
  while (pending.length) {
    const next = pending.findIndex(
      ({ coverage }) =>
        !pending.some(
          ({ bytes }) =>
            coverage.start < bytes.end && bytes.start < coverage.end,
        ),
    );
    if (next < 0) invalid("fields", "Checksum coverage contains a cycle");
    const [field] = pending.splice(next, 1);
    if (field) ordered.push(field);
  }
  return ordered;
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function unsigned(bytes: Uint8Array, byteOrder: ChecksumOrder) {
  let value = 0n;
  for (let index = 0; index < bytes.length; index++) {
    const byte =
      bytes[byteOrder === "big" ? index : bytes.length - index - 1] ?? 0;
    value = (value << 8n) + BigInt(byte);
  }
  return value;
}

function writeUnsigned(
  bytes: Uint8Array,
  byteOrder: ChecksumOrder,
  value: bigint,
) {
  for (let index = 0; index < bytes.length; index++) {
    bytes[byteOrder === "little" ? index : bytes.length - index - 1] = Number(
      value & 255n,
    );
    value >>= 8n;
  }
}

function asFloat(bytes: Uint8Array, byteOrder: ChecksumOrder) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bytes.length === 4
    ? data.getFloat32(0, byteOrder === "little")
    : data.getFloat64(0, byteOrder === "little");
}

function floatValue(value: number, path: string) {
  if (!Number.isFinite(value)) return invalid(path, "Expected a finite float");
  return Object.is(value, -0) ? "-0" : String(value);
}

function decodeField(frame: Uint8Array, field: Field): FieldReading {
  const { id, kind, unit, bytes } = field;
  const payload = frame.subarray(bytes.start, bytes.end);
  const rawHex = hex(payload);
  const result = { id, kind, unit, bytes: { ...bytes }, rawHex, value: rawHex };
  switch (kind) {
    case "bytes":
      return result;
    case "utf8": {
      try {
        return {
          ...result,
          value: new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(payload),
        };
      } catch {
        return invalid(`values.${id}`, "Invalid UTF-8 field");
      }
    }
    case "float": {
      const raw = asFloat(payload, field.order);
      const path = `values.${id}`;
      const scaled =
        field.scale === decimalUnit && field.bias === 0n
          ? raw
          : raw * (Number(field.scale) / Number(decimalUnit)) +
            Number(field.bias) / Number(decimalUnit);
      return {
        ...result,
        value: floatValue(scaled, path),
        rawValue: floatValue(raw, path),
        ...(field.calibration && {
          calibration: { ...field.calibration, status: "applied" },
        }),
      };
    }
    case "integer":
    case "bits": {
      const masked = unsigned(payload, field.order) >> BigInt(field.bitOffset);
      const raw = field.signed
        ? BigInt.asIntN(field.bitLength, masked)
        : BigInt.asUintN(field.bitLength, masked);
      const physical = field.table
        ? calibrate(field.table, raw)
        : raw * field.scale + field.bias;
      return {
        ...result,
        value: physical === undefined ? "" : decimal(physical),
        rawValue: raw.toString(),
        ...(field.calibration && {
          calibration: {
            ...field.calibration,
            status: physical === undefined ? "unmapped" : "applied",
          },
        }),
        label: field.labels.get(raw),
        ...(kind === "bits"
          ? {
              bits: {
                start: field.bitOffset,
                end: field.bitOffset + field.bitLength,
              },
            }
          : {}),
      };
    }
    case "checksum": {
      const { coverage } = field;
      const expectedHex = hex(
        checksumBytes(
          frame.subarray(coverage.start, coverage.end),
          field.algorithm,
          field.order,
        ),
      );
      return {
        ...result,
        checksum: {
          coverage: { ...coverage },
          expectedHex,
          valid: rawHex === expectedHex,
        },
      };
    }
  }
}

function encodeField(
  frame: Uint8Array,
  field: Exclude<Field, ChecksumField>,
  value: unknown,
) {
  const { id, bytes, kind } = field;
  const path = `values.${id}`;
  if (typeof value !== "string")
    return invalid(path, "Expected a field value string");
  const payload = frame.subarray(bytes.start, bytes.end);
  switch (kind) {
    case "bytes":
      if (value.length !== payload.length * 2 || !/^[0-9a-f]+$/i.test(value))
        invalid(path, "Hex byte count does not match the field width");
      for (let index = 0; index < payload.length; index++)
        payload[index] = Number.parseInt(
          value.slice(index * 2, index * 2 + 2),
          16,
        );
      return;
    case "utf8": {
      const encoded = new TextEncoder().encode(value);
      if (
        encoded.length !== payload.length ||
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(encoded) !== value
      )
        invalid(path, "UTF-8 byte count or text does not match the field");
      payload.set(encoded);
      return;
    }
    case "float": {
      if (
        value.length > 64 ||
        !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)
      )
        invalid(path, "Expected a finite decimal float");
      const desired = Number(value);
      floatValue(desired, path);
      const raw =
        field.scale === decimalUnit && field.bias === 0n
          ? desired
          : (desired - Number(field.bias) / Number(decimalUnit)) /
            (Number(field.scale) / Number(decimalUnit));
      const data = new DataView(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength,
      );
      if (payload.length === 4)
        data.setFloat32(0, raw, field.order === "little");
      else data.setFloat64(0, raw, field.order === "little");
      floatValue(asFloat(payload, field.order), path);
      return;
    }
    case "integer":
    case "bits": {
      // 64 位原值乘以允许的 40 位系数后，仍可从显示值构造。
      const physical = fixed(value, path, 61);
      const shifted = physical - field.bias;
      const raw = field.table
        ? uncalibrate(field.table, physical)
        : shifted % field.scale === 0n
          ? shifted / field.scale
          : undefined;
      if (raw === undefined)
        invalid(
          path,
          field.table
            ? "Value does not match any calibrated raw code"
            : "Value does not align with the field scale",
        );
      const { min, max } = integerLimits(field.bitLength, field.signed);
      if (raw < min || raw > max)
        invalid(path, "Value exceeds the field range");
      const shift = BigInt(field.bitOffset);
      const mask = ((1n << BigInt(field.bitLength)) - 1n) << shift;
      const patched =
        (unsigned(payload, field.order) & ~mask) |
        (BigInt.asUintN(field.bitLength, raw) << shift);
      writeUnsigned(payload, field.order, patched);
    }
  }
}

export function compileProtocolFields(definition: unknown) {
  const document = record(definition, "definition");
  only(document, ["version", "byteLength", "fields"], "definition");
  if (document.version !== "1")
    invalid("version", "Unsupported definition version");
  const byteLength = bounded(
    document.byteLength,
    1,
    maxFrameBytes,
    "byteLength",
  );
  if (
    !Array.isArray(document.fields) ||
    document.fields.length === 0 ||
    document.fields.length > maxFields
  )
    return invalid("fields", "Expected 1 to 128 fields");
  const fields = Array.from(document.fields as unknown[], (field, index) =>
    parseField(field, byteLength, index),
  );
  const ids = new Set(fields.map(({ id }) => id));
  if (ids.size !== fields.length)
    invalid("fields", "Duplicate field identifier");
  validateNonoverlapping(fields, byteLength);
  const checksums = checksumOrder(fields);
  function checkFrame(frame: Uint8Array) {
    if (frame.byteLength !== byteLength)
      invalid("frame", "Frame length differs from the definition");
  }
  return {
    byteLength,
    decode(frame: Uint8Array): FieldReading[] {
      checkFrame(frame);
      return fields.map((field) => decodeField(frame, field));
    },
    encode(values: unknown, base?: Uint8Array): Uint8Array {
      const inputs = record(values, "values");
      only(
        inputs,
        fields.filter(({ kind }) => kind !== "checksum").map(({ id }) => id),
        "values",
      );
      if (base) checkFrame(base);
      const frame = base ? Uint8Array.from(base) : new Uint8Array(byteLength);
      for (const field of fields) {
        if (field.kind !== "checksum")
          encodeField(
            frame,
            field,
            Object.hasOwn(inputs, field.id) ? inputs[field.id] : undefined,
          );
      }
      for (const field of checksums) {
        const { coverage, bytes, algorithm, order } = field;
        frame.set(
          checksumBytes(
            frame.subarray(coverage.start, coverage.end),
            algorithm,
            order,
          ),
          bytes.start,
        );
      }
      return frame;
    },
  };
}
