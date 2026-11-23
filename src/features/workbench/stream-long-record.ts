import type {
  MessageFragment,
  StreamItem,
  TerminalMode,
  TextEncoding,
} from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import type { HistoryStreamItem } from "@/lib/receive-history";
import { createTextDecoder } from "@/lib/text-encoding";
import { decodeBytes, streamSourceKey } from "./stream-model";

export const LONG_RECORD_PAGE_BYTES = 65_536;
export type LongRecordMode = TerminalMode | "split";
const INLINE_BYTES = BigInt(LONG_RECORD_PAGE_BYTES);

type RawPart = {
  itemIndex: number;
  bytesBase64: string;
  offset: bigint;
  end: bigint;
};

export type LongStreamRecord = {
  key: string;
  offset: bigint;
  end: bigint;
  message?: MessageFragment;
  parts: readonly RawPart[];
};

type AccumulatingRecord = Omit<LongStreamRecord, "parts"> & {
  owner: string;
  nextFragment?: bigint;
  parts: RawPart[];
};

export function collectLongStreamRecords(
  projected: readonly { item: StreamItem; itemIndex: number }[],
  displayed: readonly HistoryStreamItem[],
): ReadonlyMap<number, LongStreamRecord> {
  const long = new Map<number, LongStreamRecord>();
  let current: AccumulatingRecord | undefined;
  function finish() {
    if (
      current &&
      (current.end - current.offset > INLINE_BYTES ||
        (current.message &&
          BigInt(current.message.messageLength) > INLINE_BYTES))
    ) {
      for (const { itemIndex } of current.parts) long.set(itemIndex, current);
    }
    current = undefined;
  }

  for (const { item, itemIndex } of projected) {
    const event = item.kind === "source" ? item.event : undefined;
    if (
      !event ||
      (event.kind !== "rx" && event.kind !== "tx" && event.kind !== "tx_intent")
    ) {
      finish();
      continue;
    }
    const { byteStart, byteEnd, bytesBase64 } = event.payload;
    const offset = BigInt(byteStart);
    const end = BigInt(byteEnd);
    const message = event.kind === "rx" ? event.payload.message : undefined;
    const fragment = message ? BigInt(message.fragmentOffset) : undefined;
    const group =
      event.kind === "rx" ? displayed[itemIndex]?.displayRecord : undefined;
    const owner = JSON.stringify([
      streamSourceKey(event),
      event.configurationRevision,
      event.time.clockId,
      event.kind,
      message?.messageId ?? group ?? event.eventSeq,
      message?.messageId,
      message?.messageType,
      message?.messageLength,
    ]);
    if (
      !current ||
      current.owner !== owner ||
      current.end !== offset ||
      current.nextFragment !== fragment
    ) {
      finish();
      current = {
        key: JSON.stringify([owner, byteStart]),
        owner,
        offset,
        end,
        message,
        parts: [],
      };
    }
    current.parts.push({ itemIndex, bytesBase64, offset, end });
    current.end = end;
    current.nextFragment =
      fragment === undefined ? undefined : fragment + end - offset;
  }
  finish();
  return long;
}

export function presentLongRecordPage(
  record: LongStreamRecord,
  page: number,
  mode: LongRecordMode,
  encoding: TextEncoding,
) {
  const offset = record.offset + BigInt(page) * INLINE_BYTES;
  const lastOffset = offset + INLINE_BYTES;
  const end = lastOffset < record.end ? lastOffset : record.end;
  if (offset >= end) return { offset, end, text: "", hex: "" };
  const decoder = mode === "hex" ? undefined : createTextDecoder(encoding);
  const bytes =
    mode === "text" ? undefined : new Uint8Array(Number(end - offset));
  const texts: string[] = [];
  for (const part of record.parts) {
    if (part.offset >= end) break;
    if (!decoder && part.end <= offset) continue;
    const data = decodeBytes(part.bytesBase64);
    if (part.end <= offset) {
      decoder?.decode(data, { stream: true });
      continue;
    }
    const start = part.offset > offset ? part.offset : offset;
    if (decoder && part.offset < start)
      decoder.decode(data.subarray(0, Number(start - part.offset)), {
        stream: true,
      });
    const stop = part.end < end ? part.end : end;
    const slice = data.subarray(
      Number(start - part.offset),
      Number(stop - part.offset),
    );
    if (decoder)
      texts.push(decoder.decode(slice, { stream: stop !== record.end }));
    bytes?.set(slice, Number(start - offset));
  }
  return {
    offset,
    end,
    text: texts.join(""),
    hex: bytes ? formatHex(bytes) : "",
  };
}

// Resolve only explicitly opened HEX pages; a folded record cannot be copied through adjacent selection.
export function visibleLongRecordPages<
  T extends {
    longRecord?: LongStreamRecord;
    hexSource?: string;
    offset?: string;
    byteEnd?: string;
    hex?: string;
  },
>(rows: readonly T[], viewport: HTMLElement | null): readonly T[] {
  if (!viewport) return rows;
  const pages = new Map<string, number>();
  for (const node of viewport.querySelectorAll<HTMLElement>(
    "details[open] [data-long-record-page]",
  )) {
    const { hexSource, longRecordPage } = node.dataset;
    const page = Number(longRecordPage);
    if (hexSource && Number.isSafeInteger(page) && page >= 0)
      pages.set(hexSource, page);
  }
  if (!pages.size) return rows;

  return rows.map((row) => {
    const page = row.hexSource ? pages.get(row.hexSource) : undefined;
    if (!row.longRecord || page === undefined) return row;
    const shown = presentLongRecordPage(row.longRecord, page, "hex", "utf-8");
    return {
      ...row,
      offset: shown.offset.toString(),
      byteEnd: shown.end.toString(),
      hex: shown.hex,
    };
  });
}
