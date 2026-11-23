import { useMemo, useState } from "react";
import type { TextEncoding, TxReceipt } from "@serial-workbench/contracts";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WorkbenchLabels } from "./labels";
import { formatStreamHex, type HexFormat } from "./stream-hex";
import {
  LONG_RECORD_PAGE_BYTES,
  presentLongRecordPage,
  type LongStreamRecord,
  type LongRecordMode,
} from "./stream-long-record";
import { workbenchStatus } from "./stream-presentation";

export function LongStreamRecordView({
  record,
  labels,
  mode,
  encoding,
  hexFormat,
  receipt,
  hexSource,
}: {
  record: LongStreamRecord;
  labels: WorkbenchLabels;
  mode: LongRecordMode;
  encoding: TextEncoding;
  hexFormat: HexFormat;
  receipt?: TxReceipt;
  hexSource?: string;
}) {
  const [opened, setOpened] = useState(false);
  const length = record.end - record.offset;
  const declared = record.message
    ? BigInt(record.message.messageLength)
    : undefined;
  const partial =
    record.message &&
    (record.message.fragmentOffset !== "0" || declared !== length);
  return (
    <details
      className="workbench-long-record"
      onToggle={(event) => setOpened(event.currentTarget.open)}
    >
      <summary>
        {labels.longRecord} · {length.toString()}
        {partial ? "/" + declared?.toString() : ""} B
        {record.message ? " · " + record.message.messageType : ""}
        {partial ? " · " + labels.longRecordPartial : ""}
        {receipt ? " · " + workbenchStatus(receipt.outcome, labels) : ""}
        {receipt?.backendError ? " · " + receipt.backendError.code : ""}
      </summary>
      {opened && (
        <LongRecordPage
          record={record}
          labels={labels}
          mode={mode}
          encoding={encoding}
          hexFormat={hexFormat}
          hexSource={hexSource}
        />
      )}
    </details>
  );
}

function LongRecordPage({
  record,
  labels,
  mode,
  encoding,
  hexFormat,
  hexSource,
}: {
  record: LongStreamRecord;
  labels: WorkbenchLabels;
  mode: LongRecordMode;
  encoding: TextEncoding;
  hexFormat: HexFormat;
  hexSource?: string;
}) {
  const [requested, setRequested] = useState(0);
  const pageCount = Math.max(
    1,
    Math.ceil(Number(record.end - record.offset) / LONG_RECORD_PAGE_BYTES),
  );
  const page = Math.min(requested, pageCount - 1);
  const content = useMemo(
    () => presentLongRecordPage(record, page, mode, encoding),
    [record, page, mode, encoding],
  );
  const hex = useMemo(
    () =>
      mode === "text"
        ? ""
        : formatStreamHex(content.hex, content.offset.toString(), hexFormat),
    [content, mode, hexFormat],
  );

  return (
    <div className="workbench-long-record-page">
      <div className="workbench-long-record-navigation">
        <span role="status">
          {labels.offset} [{content.offset.toString()}, {content.end.toString()}
          ) · {page + 1}/{pageCount}
        </span>
        {pageCount > 1 && (
          <>
            <Button
              type="button"
              size="icon-xs"
              variant="outline"
              aria-label={labels.longRecordPrevious}
              disabled={page === 0}
              onClick={() => setRequested(page - 1)}
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="outline"
              aria-label={labels.longRecordNext}
              disabled={page + 1 >= pageCount}
              onClick={() => setRequested(page + 1)}
            >
              <ArrowRight aria-hidden="true" />
            </Button>
          </>
        )}
      </div>
      {mode !== "hex" && (
        <pre
          className="workbench-payload"
          aria-label={labels.text}
          tabIndex={0}
        >
          {content.text}
        </pre>
      )}
      {mode !== "text" && (
        <pre
          className="workbench-payload"
          dir="ltr"
          data-long-record-page={page}
          data-hex-source={hexSource}
          data-hex-byte-start={content.offset.toString()}
          data-hex-byte-count={Number(content.end - content.offset)}
          data-hex-grouped={hexFormat.columns !== "0" || undefined}
          aria-label={labels.hex}
          tabIndex={0}
        >
          {hex}
        </pre>
      )}
    </div>
  );
}
