import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";
import { encodeMdf4, type MeasurementChannel } from "./encode.ts";

const packageId = "swb.pro.mdf4";
const maxChannels = 16;
const maxSamples = 256;
const u64Maximum = (1n << 64n) - 1n;
const i64Maximum = (1n << 63n) - 1n;
const i64Minimum = -(1n << 63n);

function object(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseInteger(input: unknown, signed: boolean) {
  if (
    typeof input !== "string" ||
    !(
      signed ? /^-?(?:0|[1-9][0-9]{0,19})$/u : /^(?:0|[1-9][0-9]{0,19})$/u
    ).test(input)
  )
    throw new Error("MDF4 integer values must be decimal strings");
  const value = BigInt(input);
  if (signed ? value < i64Minimum || value > i64Maximum : value > u64Maximum)
    throw new Error("MDF4 integer value is outside its 64-bit range");
  return value;
}

function parseFloat64(input: unknown) {
  if (
    typeof input !== "string" ||
    input.length > 32 ||
    !/^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?$/u.test(input)
  )
    throw new Error("MDF4 float values must be finite decimal strings");
  const value = Number(input);
  if (!Number.isFinite(value))
    throw new Error("MDF4 float value is outside its range");
  return value;
}

function decodeMeasurement(input: unknown) {
  if (
    !object(input) ||
    !Array.isArray(input.channels) ||
    input.channels.length === 0 ||
    input.channels.length > maxChannels ||
    !Array.isArray(input.samples) ||
    input.samples.length === 0 ||
    input.samples.length > maxSamples
  )
    throw new Error("MDF4 requires 1–16 channels and 1–256 samples");

  const names = new Set(["time", "elapsed_ns"]);
  const channels = input.channels.map((entry: unknown): MeasurementChannel => {
    if (
      !object(entry) ||
      typeof entry.name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(entry.name) ||
      names.has(entry.name) ||
      (entry.type !== "float64" &&
        entry.type !== "uint64" &&
        entry.type !== "int64") ||
      (entry.unit !== undefined &&
        (typeof entry.unit !== "string" ||
          [...entry.unit].length > 32 ||
          // eslint-disable-next-line no-control-regex -- MDF 文本块以 NUL 结束。
          /[\u0000-\u001f\u007f]/u.test(entry.unit)))
    )
      throw new Error("MDF4 channel name, type, or unit is invalid");
    names.add(entry.name);
    return { name: entry.name, type: entry.type, unit: entry.unit };
  });

  let previous = 0n;
  const samples = input.samples.map((entry: unknown) => {
    if (
      !object(entry) ||
      !Array.isArray(entry.values) ||
      entry.values.length !== channels.length
    )
      throw new Error("MDF4 row must provide one value per channel");
    const elapsedNs = parseInteger(entry.elapsedNs, false);
    if (elapsedNs < previous)
      throw new Error("MDF4 sample time moved backwards");
    previous = elapsedNs;
    const values = entry.values.map((value: unknown, index: number) => {
      if (value === null) return null;
      const { type } = channels[index]!;
      return type === "float64"
        ? parseFloat64(value)
        : parseInteger(value, type === "int64");
    });
    return { elapsedNs, values };
  });
  const startTimeNs = parseInteger(input.startTimeNs, false);
  if (startTimeNs + previous > u64Maximum)
    throw new Error("MDF4 measurement timestamps exceed the 64-bit range");

  return { startTimeNs, channels, samples };
}

export const register: NodeRegister = (context) => {
  context.actions.register(`${packageId}.exportMdf4`, (call, task) => {
    task.signal.throwIfAborted();
    const file = encodeMdf4(decodeMeasurement(call.params));
    return file.toString("base64");
  });
  return () => {};
};
