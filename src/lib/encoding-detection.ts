import { analyse } from "chardet";
import type { TextEncoding } from "@serial-workbench/contracts";
import { createTextDecoder } from "./text-encoding";
export type EncodingCandidate = {
  encoding: TextEncoding;
  reason: "bom" | "utf8" | "guess";
  confidence: number;
};
export type EncodingDetection = (
  EncodingCandidate | { encoding: "utf-8"; reason: "pending"; confidence: 0 }
) & {
  sampleBytes: number;
  candidates: readonly EncodingCandidate[];
};
const DETECTED_ENCODINGS: Record<string, TextEncoding> = {
  "UTF-8": "utf-8",
  "UTF-16LE": "utf-16le",
  "UTF-16BE": "utf-16be",
  GB18030: "gb18030",
  Big5: "big5",
  Shift_JIS: "shift-jis",
  "ISO-8859-1": "latin1",
  ASCII: "ascii",
};
export function detectTextEncoding(sample: string): EncodingDetection {
  const bytes = Uint8Array.from(sample, (value) => value.charCodeAt(0));
  const bom: TextEncoding | undefined =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
          ? "utf-8"
          : undefined;
  const result = (
    preferred: EncodingCandidate,
    guesses: readonly EncodingCandidate[] = [],
  ): EncodingDetection => ({
    ...preferred,
    sampleBytes: bytes.length,
    candidates: [
      preferred,
      ...guesses.filter((guess) => guess.encoding !== preferred.encoding),
    ].slice(0, 4),
  });
  const pending: EncodingDetection = {
    encoding: "utf-8",
    reason: "pending",
    confidence: 0,
    sampleBytes: bytes.length,
    candidates: [],
  };
  if (bom) return result({ encoding: bom, reason: "bom", confidence: 100 });
  const matches = analyse(bytes);
  const utf16 = matches.find(
    (candidate) =>
      (candidate.name === "UTF-16LE" || candidate.name === "UTF-16BE") &&
      candidate.confidence >= 60,
  );
  if (!utf16 && !bytes.some((byte) => byte > 127)) return pending;
  const utf8 = strictSample(bytes, "utf-8");
  const guesses: EncodingCandidate[] = [];
  const seen = new Set<TextEncoding>();
  for (const candidate of matches) {
    const encoding = DETECTED_ENCODINGS[candidate.name];
    if (!encoding || candidate.confidence < 30 || seen.has(encoding)) continue;
    if (
      (encoding === "utf-8" ? utf8 : strictSample(bytes, encoding)) ===
      undefined
    )
      continue;
    seen.add(encoding);
    guesses.push({
      encoding,
      reason: "guess",
      confidence: candidate.confidence,
    });
  }
  const wide =
    utf16 &&
    guesses.find(
      (candidate) => candidate.encoding === DETECTED_ENCODINGS[utf16.name],
    );
  const preferred =
    wide ||
    (utf8 && Array.from(utf8).some((character) => character.charCodeAt(0) > 127)
      ? ({ encoding: "utf-8", reason: "utf8", confidence: 100 } as const)
      : guesses[0]);
  return preferred ? result(preferred, guesses) : pending;
}

function strictSample(
  bytes: Uint8Array,
  encoding: TextEncoding,
): string | undefined {
  try {
    return createTextDecoder(encoding, { fatal: true }).decode(bytes, {
      stream: true,
    });
  } catch {
    return undefined;
  }
}
