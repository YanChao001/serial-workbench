import iconv from "iconv-lite";
import { Buffer } from "buffer";
import type { TextEncoding } from "@serial-workbench/contracts";

export function encode(text: string, encoding: TextEncoding): Uint8Array {
  return new Uint8Array(iconv.encode(text, encoding, { addBOM: false }));
}

export function decode(bytes: Uint8Array, encoding: TextEncoding): string {
  return iconv.decode(Buffer.from(bytes), encoding, { stripBOM: false });
}
