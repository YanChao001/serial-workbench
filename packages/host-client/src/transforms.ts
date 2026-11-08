import type { LineEnding } from "@serial-workbench/contracts";
import { parseHex } from "./hex";

function lineEndingBytes(ending: LineEnding): Uint8Array {
  switch (ending.kind) {
    case "none":
      return new Uint8Array();
    case "cr":
      return Uint8Array.of(13);
    case "lf":
      return Uint8Array.of(10);
    case "crlf":
      return Uint8Array.of(13, 10);
    case "custom": {
      const decoded = atob(ending.bytesBase64);
      // atob 接受空白、缺 padding 和非零 pad bits；Host Bytes 只接受规范 Base64。
      if (btoa(decoded) !== ending.bytesBase64) {
        throw new Error("Custom line ending must use canonical Base64");
      }
      return Uint8Array.from(decoded, (byte) => byte.charCodeAt(0));
    }
  }
}

export function encodeSend(
  input: string,
  mode: "text" | "hex",
  ending: LineEnding,
): Uint8Array {
  const body =
    mode === "text" ? new TextEncoder().encode(input) : parseHex(input);
  const suffix = lineEndingBytes(ending);
  const bytes = new Uint8Array(body.length + suffix.length);
  bytes.set(body);
  bytes.set(suffix, body.length);
  return bytes;
}
