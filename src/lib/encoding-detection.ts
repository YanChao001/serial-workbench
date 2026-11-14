import { analyse } from "chardet";
import type { TextEncoding } from "@serial-workbench/contracts";
import { createTextDecoder } from "./text-encoding";
export type EncodingDetection = {
  encoding: TextEncoding;
  reason: "bom" | "utf8" | "guess" | "pending";
  confidence: number;
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
  if (bom) return { encoding: bom, reason: "bom", confidence: 100 };
  const candidates = analyse(bytes);
  const utf16 = candidates.find(
    (candidate) =>
      candidate.name.startsWith("UTF-16") && candidate.confidence >= 60,
  );
  if (utf16)
    return {
      encoding: DETECTED_ENCODINGS[utf16.name]!,
      reason: "guess",
      confidence: utf16.confidence,
    };
  if (!bytes.some((byte) => byte > 127))
    return { encoding: "utf-8", reason: "pending", confidence: 0 };
  try {
    const text = createTextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: true,
    });
    if (Array.from(text).some((character) => character.codePointAt(0)! > 127))
      return { encoding: "utf-8", reason: "utf8", confidence: 100 };
  } catch {
    /* 尝试统计候选。 */
  }
  for (const candidate of candidates) {
    const encoding = DETECTED_ENCODINGS[candidate.name];
    if (!encoding || candidate.confidence < 30) continue;
    try {
      createTextDecoder(encoding, { fatal: true }).decode(bytes, {
        stream: true,
      });
      return { encoding, reason: "guess", confidence: candidate.confidence };
    } catch {
      /* 候选须符合字节结构。 */
    }
  }
  return { encoding: "utf-8", reason: "pending", confidence: 0 };
}
