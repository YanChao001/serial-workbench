import type {
  FileTransferReceiptsParams,
  FileTransferReceiptsResult,
  ObjectRef,
} from "@serial-workbench/contracts";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { WorkbenchLabels } from "./labels";
export type ReceiptReader = (
  params: FileTransferReceiptsParams,
  signal?: AbortSignal,
) => Promise<FileTransferReceiptsResult>;
export type TransferReceiptsProps = {
  receiptsRef: ObjectRef;
  read: ReceiptReader;
  labels: WorkbenchLabels;
};
export function TransferReceipts({
  receiptsRef,
  read,
  labels,
}: TransferReceiptsProps) {
  const [page, setPage] = useState<{
    result: FileTransferReceiptsResult;
    start: string;
    history: string[];
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function load(start: string, history: string[]) {
    if (busy) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const result = await read(
        {
          receiptsRef,
          startOrdinal: start,
          maxReceipts: "32",
          maxBytes: "65536",
        },
        controller.signal,
      );
      if (!controller.signal.aborted) setPage({ result, start, history });
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label={labels.receipt} aria-busy={busy}>
      <div className="workbench-toolbar">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void load("0", [])}
        >
          {labels.receipt}
        </Button>
        {page && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !page.history.length}
              onClick={() =>
                void load(page.history.at(-1)!, page.history.slice(0, -1))
              }
            >
              {labels.previousPage}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !page.result.hasMore}
              onClick={() =>
                void load(page.result.nextOrdinal, [
                  ...page.history,
                  page.start,
                ])
              }
            >
              {labels.nextPage}
            </Button>
          </>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {page && (
        <ul>
          {page.result.receipts.map(({ sourceOffset, receipt }) => (
            <li
              key={`${sourceOffset}:${receipt.operationId}:${receipt.byteStart}`}
            >
              <span>
                {labels.offset} {sourceOffset}
              </span>{" "}
              <span>
                {receipt.outcome} [{receipt.byteStart}, {receipt.byteEnd})
              </span>
              {receipt.unknownRanges.map((range) => (
                <p key={range.start}>
                  {labels.unknownBytes}: [{range.start}, {range.end})
                </p>
              ))}
              {receipt.backendError && (
                <p>
                  {receipt.backendError.code}: {receipt.backendError.message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
