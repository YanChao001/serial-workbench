import { formatHex, parseHex } from "@serial-workbench/host-client";
import type { TextEncoding } from "@serial-workbench/contracts";
import { createTextDecoder, encodeText } from "@/lib/text-encoding";

export type DraftConversion =
  | { ok: true; draft: string }
  | {
      ok: false;
      code:
        "INVALID_HEX" | "INVALID_UTF8" | "INVALID_ENCODING" | "UNREPRESENTABLE";
    };

/** 只转换正文；行尾仍由发送编码器追加一次。 */
export function convertSendDraft(
  draft: string,
  from: "text" | "hex",
  to: "text" | "hex",
  encoding: TextEncoding = "utf-8",
): DraftConversion {
  if (from === to) return { ok: true, draft };
  if (from === "text") {
    try {
      return { ok: true, draft: formatHex(encodeText(draft, encoding)) };
    } catch {
      return { ok: false, code: "UNREPRESENTABLE" };
    }
  }
  let bytes: Uint8Array;
  try {
    bytes = parseHex(draft);
  } catch {
    return { ok: false, code: "INVALID_HEX" };
  }
  try {
    // ignoreBOM 保留开头的 U+FEFF，避免再编码时丢失原始 EF BB BF。
    const decoded = createTextDecoder(encoding, {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return { ok: true, draft: decoded };
  } catch {
    return {
      ok: false,
      code: encoding === "utf-8" ? "INVALID_UTF8" : "INVALID_ENCODING",
    };
  }
}
