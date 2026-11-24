import { crcValue, type CrcParameters } from "../../src/crc.ts";
import type { ChecksumOrder } from "../../src/wire-checksum.ts";
import { ProtocolFieldError } from "../reference-framing/protocol-fields.ts";
import { crcModels, crcWidths } from "./crc-catalogue.ts";

export const maxCrcSamples = 16;
export const maxCrcSampleBytes = 4096;

export type CrcSample = { bytes: Uint8Array; checksum: Uint8Array };
export type CrcOrder = "auto" | ChecksumOrder;
type CrcCandidate = CrcParameters & { name: string; order: ChecksumOrder };
type CrcEvidence = {
  status: "matched" | "more-samples" | "no-match" | "contradictory";
  distinctSamples: number;
  duplicateSamples: number;
  candidates: CrcCandidate[];
};

function integer(bytes: Uint8Array, order: ChecksumOrder) {
  let value = 0;
  for (let index = 0; index < bytes.length; index++) {
    const offset = order === "little" ? bytes.length - 1 - index : index;
    value = value * 256 + bytes[offset]!;
  }
  return value;
}

export function recognizeCrc(
  samples: readonly CrcSample[],
  { width, order = "auto" }: { width?: number; order?: CrcOrder } = {},
): CrcEvidence {
  if (samples.length === 0 || samples.length > maxCrcSamples)
    throw new ProtocolFieldError(
      "samples",
      "Sample count is outside the supported range",
    );
  if (width !== undefined && !crcWidths.includes(width))
    throw new ProtocolFieldError("width", "Width is outside the CRC catalogue");
  const checksumLength = samples[0]!.checksum.length;
  const distinct = new Map<
    string,
    { bytes: Uint8Array; big: number; little: number; variants: Set<number> }
  >();
  let contradictory = false;
  let duplicates = 0;
  for (const [index, { bytes, checksum }] of samples.entries()) {
    if (bytes.length === 0 || bytes.length > maxCrcSampleBytes)
      throw new ProtocolFieldError(
        `samples[${index}].bytes`,
        "Invalid sample length",
      );
    if (
      checksum.length === 0 ||
      checksum.length > 4 ||
      checksum.length !== checksumLength ||
      (width !== undefined && checksum.length !== Math.ceil(width / 8))
    )
      throw new ProtocolFieldError(
        `samples[${index}].checksum`,
        "Checksum length does not match the other samples or the selected width",
      );
    const key = String.fromCharCode(...bytes);
    const big = integer(checksum, "big");
    const previous = distinct.get(key);
    if (previous) {
      contradictory ||= previous.big !== big;
      if (previous.variants.has(big)) duplicates++;
      previous.variants.add(big);
      continue;
    }
    distinct.set(key, {
      bytes,
      big,
      little: integer(checksum, "little"),
      variants: new Set([big]),
    });
  }
  const observed = {
    distinctSamples: distinct.size,
    duplicateSamples: duplicates,
  };
  if (contradictory)
    return { ...observed, status: "contradictory", candidates: [] };

  const candidates: CrcCandidate[] = [];
  for (const model of crcModels) {
    if (
      Math.ceil(model.width / 8) !== checksumLength ||
      (width !== undefined && model.width !== width)
    )
      continue;
    let big = order !== "little" || checksumLength === 1;
    let little = order !== "big" && checksumLength > 1;
    for (const sample of distinct.values()) {
      const computed = crcValue(sample.bytes, model);
      big &&= computed === sample.big;
      little &&= computed === sample.little;
      if (!big && !little) break;
    }
    const { name, polynomial, initial, reflectInput, reflectOutput, finalXor } =
      model;
    const candidate = {
      name,
      width: model.width,
      polynomial,
      initial,
      reflectInput,
      reflectOutput,
      finalXor,
    };
    if (big) candidates.push({ ...candidate, order: "big" });
    if (little) candidates.push({ ...candidate, order: "little" });
  }
  const status =
    candidates.length === 0
      ? "no-match"
      : candidates.length === 1 && distinct.size >= 2
        ? "matched"
        : "more-samples";
  return { ...observed, status, candidates };
}
