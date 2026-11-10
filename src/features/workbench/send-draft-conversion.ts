import { formatHex, parseHex } from "@serial-workbench/host-client";

export type DraftConversion =
  | { ok: true; draft: string }
  | { ok: false; code: "INVALID_HEX" | "INVALID_UTF8" };

/** 只转换正文；行尾仍由发送编码器追加一次。文本模式当前仅支持 UTF-8。 */
export function convertSendDraft(
  draft: string,
  from: "text" | "hex",
  to: "text" | "hex",
): DraftConversion {
  if (from === to) return { ok: true, draft };
  if (from === "text")
    return { ok: true, draft: formatHex(new TextEncoder().encode(draft)) };
  let bytes: Uint8Array;
  try {
    bytes = parseHex(draft);
  } catch {
    return { ok: false, code: "INVALID_HEX" };
  }
  try {
    // ignoreBOM 保留开头的 U+FEFF，避免再编码时丢失原始 EF BB BF。
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return { ok: true, draft: decoded };
  } catch {
    return { ok: false, code: "INVALID_UTF8" };
  }
}
