import type { StreamItem } from "@serial-workbench/contracts";
import { streamSourceKey } from "./stream-model";

const SAMPLE_BYTES = 8192;

/** 缺口两侧的字节不参与同一次编码识别。 */
export function receiveEncodingSample(items: readonly StreamItem[]): string {
  return collectReceiveSample(items, false).bytes;
}

/** 文本预览独立保留报文边界，跳过显式标记的二进制帧。 */
export function receiveTextSample(items: readonly StreamItem[]) {
  return collectReceiveSample(items, true);
}

function collectReceiveSample(items: readonly StreamItem[], textOnly: boolean) {
  let sample = "";
  let latest = { bytes: "", completeMessage: false };
  let source: string | undefined, end: string | undefined;
  let messageId: string | undefined, revision: string | undefined;
  for (const item of items) {
    if (
      item.kind === "reader_gap" ||
      ["gap", "configuration_boundary", "lifecycle"].includes(
        item.event.kind,
      ) ||
      (textOnly &&
        item.event.kind === "rx" &&
        item.event.payload.message?.messageType === "binary")
    ) {
      sample = "";
      source = undefined;
      end = undefined;
    } else if (item.event.kind === "rx") {
      const key = streamSourceKey(item.event);
      const payload = item.event.payload;
      const message = payload.message;
      if (
        source !== key ||
        end !== payload.byteStart ||
        (textOnly &&
          (message?.messageId !== messageId ||
            revision !== item.event.configurationRevision))
      )
        sample = "";
      messageId = message?.messageId;
      revision = item.event.configurationRevision;
      source = key;
      end = payload.byteEnd;
      if (sample.length < SAMPLE_BYTES) {
        const remaining = SAMPLE_BYTES - sample.length;
        sample += atob(
          payload.bytesBase64.slice(0, Math.ceil(remaining / 3) * 4),
        ).slice(0, remaining);
        latest = {
          bytes: sample,
          completeMessage:
            textOnly &&
            message !== undefined &&
            sample.length < SAMPLE_BYTES &&
            BigInt(message.fragmentOffset) +
              BigInt(payload.byteEnd) -
              BigInt(payload.byteStart) ===
              BigInt(message.messageLength),
        };
      }
    }
  }
  return latest;
}
