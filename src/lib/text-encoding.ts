import type {
  LineEnding,
  TerminalMode,
  TextEncoding,
} from "@serial-workbench/contracts";
import { encodeSend } from "@serial-workbench/host-client";

export const TEXT_ENCODINGS = [
  "utf-8",
  "gbk",
  "gb18030",
  "big5",
  "shift-jis",
  "latin1",
  "ascii",
  "utf-16le",
  "utf-16be",
] as const satisfies readonly TextEncoding[];
export const ENCODING_NAMES: Record<TextEncoding, string> = {
  "utf-8": "UTF-8",
  gbk: "GBK",
  gb18030: "GB18030",
  big5: "Big5",
  "shift-jis": "Shift-JIS",
  latin1: "Latin-1",
  ascii: "ASCII",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
};
export function isTextEncoding(value: string): value is TextEncoding {
  return TEXT_ENCODINGS.some((encoding) => encoding === value);
}
/** null 表示自动识别，缺失值沿用 UTF-8 默认值。 */
export function receiveEncodingFor(
  ...values: (TextEncoding | null | undefined)[]
): TextEncoding | null {
  const selected = values.find((value) => value !== undefined);
  return selected === undefined ? "utf-8" : selected;
}

type LegacyCodec = typeof import("./legacy-text-encoding");
let legacy: LegacyCodec | undefined;
let pending: Promise<void> | undefined;
let status: "idle" | "loading" | "ready" | "error" = "idle";
const listeners = new Set<() => void>();
export const encodingBackendStatus = () => status;
export function subscribeEncodingBackend(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function publish() {
  for (const listener of listeners) listener();
}
/** 常用 UTF-8 路径不加载传统编码表，首次需要时共享同一次加载。 */
export function prepareTextEncoding(encoding: TextEncoding): Promise<void> {
  if (encoding === "utf-8" || legacy) return Promise.resolve();
  if (!pending) {
    status = "loading";
    pending = import("./legacy-text-encoding").then(
      (module) => {
        legacy = module;
        status = "ready";
        publish();
      },
      (error: unknown) => {
        pending = undefined;
        status = "error";
        publish();
        throw error;
      },
    );
    publish();
  }
  return pending;
}
export class TextEncodingError extends Error {
  constructor(public readonly code: "unrepresentable" | "loading") {
    super(code);
  }
}
export function encodeText(text: string, encoding: TextEncoding): Uint8Array {
  if (encoding === "utf-8") {
    const bytes = new TextEncoder().encode(text);
    if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== text)
      throw new TextEncodingError("unrepresentable");
    return bytes;
  }
  if (!legacy) throw new TextEncodingError("loading");
  const bytes = legacy.encode(text, encoding);
  if (legacy.decode(bytes, encoding) !== text)
    throw new TextEncodingError("unrepresentable");
  return bytes;
}
export function encodedCharacterBytes(
  code: number,
  encoding: TextEncoding,
): number {
  if (encoding === "utf-8") {
    return code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  if (encoding === "utf-16le" || encoding === "utf-16be")
    return code > 65535 ? 4 : 2;
  if (encoding === "ascii" || encoding === "latin1") return 1;
  if (!legacy) throw new TextEncodingError("loading");
  return legacy.encode(String.fromCodePoint(code), encoding).length;
}
export function createTextDecoder(
  encoding: TextEncoding,
  options: TextDecoderOptions = {},
): {
  decode(bytes?: Uint8Array, options?: TextDecodeOptions): string;
} {
  if (encoding !== "ascii" && encoding !== "latin1")
    return new TextDecoder(
      encoding === "shift-jis" ? "shift_jis" : encoding,
      options,
    );
  return {
    decode(bytes = new Uint8Array()) {
      let text = "";
      for (const byte of bytes) {
        if (encoding === "ascii" && byte > 127) {
          if (options.fatal) throw new TypeError("Invalid ASCII data");
          text += "\uFFFD";
        } else text += String.fromCharCode(byte);
      }
      return text;
    },
  };
}
export function encodeTextSend(
  draft: string,
  mode: TerminalMode,
  ending: LineEnding,
  encoding: TextEncoding,
): Uint8Array {
  const suffixes = { none: "", cr: "\r", lf: "\n", crlf: "\r\n" };
  if (mode === "text" && ending.kind !== "custom")
    return encodeText(draft + suffixes[ending.kind], encoding);
  const body =
    mode === "hex"
      ? encodeSend(draft, "hex", { kind: "none" })
      : encodeText(draft, encoding);
  const suffix =
    ending.kind === "custom"
      ? encodeSend("", "hex", ending)
      : ending.kind === "none"
        ? new Uint8Array()
        : encodeText(suffixes[ending.kind], encoding);
  if (suffix.length === 0) return body;
  const result = new Uint8Array(body.length + suffix.length);
  result.set(body);
  result.set(suffix, body.length);
  return result;
}
