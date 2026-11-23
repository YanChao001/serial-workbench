import {
  TX_MAX_BYTES,
  type Operation,
  type PasteTransferParams,
  type SerialConfiguration,
  type TextEncoding,
} from "@serial-workbench/contracts";
import { bytesToBase64 } from "@/lib/base64";
import type { WriteWaitMode } from "@/lib/generated/bindings";
import { encodeText } from "@/lib/text-encoding";
import { sendWaitMs, serialHalfBitsPerByte } from "./send-wait";

const protocolEncoder = new TextEncoder();
const bracketStart = protocolEncoder.encode("\x1b[200~");
const bracketEndSequence = "\x1b[201~";
const bracketEnd = protocolEncoder.encode(bracketEndSequence);
const MAX_PASTE_CHUNK_BYTES = 256;
const MAX_PASTE_BYTES_PER_SECOND = 4096;
const PASTE_INTERVAL_MS = 20;

export type AnsiPasteTarget = {
  start(bytes: Uint8Array): Promise<Operation>;
  wait(operation: Operation, signal: AbortSignal): Promise<Operation>;
  cancel(operation: Operation): Promise<void>;
};

export type PasteEncoding =
  { bytes: Uint8Array } | { error: "encoding" | "overflow" | "bracket" };

export function encodeAnsiPaste(
  text: string,
  encoding: TextEncoding,
  bracketed: boolean,
): PasteEncoding {
  // CRLF normalization can at most halve the input. Bound conversion work as well.
  if (text.length > TX_MAX_BYTES * 2) return { error: "overflow" };
  if (
    bracketed &&
    (text.includes(bracketEndSequence) || text.includes("\u009b201~"))
  )
    return { error: "bracket" };
  let body: Uint8Array;
  try {
    body = encodeText(text.replace(/\r?\n/g, "\r"), encoding);
  } catch {
    return { error: "encoding" };
  }
  const length =
    body.length + (bracketed ? bracketStart.length + bracketEnd.length : 0);
  if (length > TX_MAX_BYTES) return { error: "overflow" };
  if (!bracketed) return { bytes: body };
  const bytes = new Uint8Array(length);
  bytes.set(bracketStart);
  bytes.set(body, bracketStart.length);
  bytes.set(bracketEnd, bracketStart.length + body.length);
  return { bytes };
}

export function ansiPasteParams(
  bytes: Uint8Array,
  configuration: SerialConfiguration,
  writeWait: WriteWaitMode,
): PasteTransferParams {
  const lineBytesPerSecond = Math.floor(
    (Number(configuration.baudRate) * 2) / serialHalfBitsPerByte(configuration),
  );
  const bytesPerSecond = Math.max(
    1,
    Math.min(lineBytesPerSecond, MAX_PASTE_BYTES_PER_SECOND),
  );
  const chunkBytes = Math.min(
    MAX_PASTE_CHUNK_BYTES,
    Math.max(1, Math.floor(bytesPerSecond / 10)),
    bytes.length,
  );
  return {
    bytesBase64: bytesToBase64(bytes),
    chunkBytes: String(chunkBytes),
    bytesPerSecond: String(bytesPerSecond),
    interChunkMs: String(PASTE_INTERVAL_MS),
    writeWaitMs: sendWaitMs(configuration, chunkBytes, writeWait),
  };
}
