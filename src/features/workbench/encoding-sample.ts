import type { StreamItem } from "@serial-workbench/contracts";
import { streamSourceKey } from "./stream-model";

const SAMPLE_BYTES = 8192;
/** 保留最后一段 RX 的有界前缀；缺口两侧的字节不参与同一次识别。 */
export function receiveEncodingSample(items: readonly StreamItem[]): string {
  let sample = "",
    latest = "";
  let source: string | undefined, end: string | undefined;
  for (const item of items) {
    if (
      item.kind === "reader_gap" ||
      ["gap", "configuration_boundary", "lifecycle"].includes(item.event.kind)
    ) {
      sample = "";
      source = undefined;
      end = undefined;
    } else if (item.event.kind === "rx") {
      const key = streamSourceKey(item.event);
      if (source !== key || end !== item.event.payload.byteStart) sample = "";
      source = key;
      end = item.event.payload.byteEnd;
      if (sample.length < SAMPLE_BYTES) {
        const remaining = SAMPLE_BYTES - sample.length;
        sample += atob(
          item.event.payload.bytesBase64.slice(0, Math.ceil(remaining / 3) * 4),
        ).slice(0, remaining);
        latest = sample;
      }
    }
  }
  return sample || latest;
}
