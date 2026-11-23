import { expect, it } from "vitest";
import type { HistoryStreamItem } from "@/lib/receive-history";
import { bytesToBase64 } from "@/lib/base64";
import {
  collectLongStreamRecords,
  LONG_RECORD_PAGE_BYTES,
  presentLongRecordPage,
} from "./stream-long-record";
import { projectStreamItems } from "./stream-model";
import { txItem } from "./test-fixtures";

const address = 9_007_199_254_741_025n;
function packet(
  data: Uint8Array,
  offset: number,
  declared: bigint,
  sequence: string,
): HistoryStreamItem {
  const source = txItem("tx");
  if (source.kind !== "source") throw new Error("Missing fixture");
  return {
    kind: "source",
    displayRecord: "test-record",
    event: {
      ...source.event,
      eventSeq: sequence,
      kind: "rx",
      payload: {
        bytesBase64: bytesToBase64(data),
        byteStart: (address + BigInt(offset)).toString(),
        byteEnd: (address + BigInt(offset + data.length)).toString(),
        message: {
          messageId: "message",
          messageType: "test",
          fragmentOffset: String(offset),
          messageLength: declared.toString(),
        },
      },
    },
  };
}

it("pages a long retained message and decodes UTF-8 across the page boundary", () => {
  const start = new Uint8Array(LONG_RECORD_PAGE_BYTES).fill(65);
  start[start.length - 1] = 0xe4;
  const end = Uint8Array.of(0xb8, 0xad, 90);
  const count = BigInt(start.length + end.length);
  const items = [
    packet(start, 0, count, "1"),
    packet(end, start.length, count, "2"),
  ];
  const long = collectLongStreamRecords(projectStreamItems(items), items);
  const record = long.get(0);
  if (!record) throw new Error("Missing long message");
  expect(long.get(1)).toBe(record);
  expect(record.end - record.offset).toBe(count);
  const first = presentLongRecordPage(record, 0, "text", "utf-8");
  expect(first.text).toBe("A".repeat(LONG_RECORD_PAGE_BYTES - 1));
  expect(first.hex).toBe("");
  const last = presentLongRecordPage(record, 1, "split", "utf-8");
  expect(last).toEqual({
    offset: address + BigInt(LONG_RECORD_PAGE_BYTES),
    end: address + count,
    text: "中Z",
    hex: "B8 AD 5A",
  });
});

it("summarizes a declared full-width length without joining or allocating missing data", () => {
  const declared = 18_446_744_073_709_551_614n;
  const head = packet(Uint8Array.of(65), 0, declared, "1");
  const tail = packet(Uint8Array.of(66), 3, declared, "3");
  const items = [head, tail];
  const long = collectLongStreamRecords(projectStreamItems(items), items);
  const record = long.get(0);
  if (!record) throw new Error("Missing retained fragment");
  expect(long.get(1)).not.toBe(record);
  expect(record.message?.messageLength).toBe(declared.toString());
  expect(presentLongRecordPage(record, 0, "hex", "utf-8")).toEqual({
    offset: address,
    end: address + 1n,
    text: "",
    hex: "41",
  });
});
