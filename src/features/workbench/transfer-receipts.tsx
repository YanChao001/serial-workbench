import type {
  FileTransferReceiptsParams,
  FileTransferReceiptsResult,
  ObjectRef,
} from "@serial-workbench/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { nativeErrorCode } from "@/lib/native-error";
import type { WorkbenchLabels } from "./labels";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { operationFailureEventKey, WorkbenchNotice } from "./workbench-notice";
export type ReceiptReader = (
  params: FileTransferReceiptsParams,
  signal?: AbortSignal,
) => Promise<FileTransferReceiptsResult>;
export type TransferReceiptsProps = {
  receiptsRef: ObjectRef;
  read: ReceiptReader;
  labels: WorkbenchLabels;
};
export function TransferReceipts(props: TransferReceiptsProps) {
  const reference = props.receiptsRef;
  return (
    <TransferReceiptsView
      key={JSON.stringify([
        reference.hostId,
        reference.kind,
        reference.id,
        reference.revision,
      ])}
      {...props}
    />
  );
}
function TransferReceiptsView({
  receiptsRef,
  read,
  labels,
}: TransferReceiptsProps) {
  const [snapshot, setSnapshot] = useState<{
    read: ReceiptReader;
    result: FileTransferReceiptsResult;
    start: string;
    history: string[];
  }>();
  const [busy, setBusy] = useState(false);
  const page = snapshot?.read === read ? snapshot : undefined;
  const [failed, setFailed] = useState<{
    read: ReceiptReader;
    code?: string;
    eventKey?: string;
  }>();
  const failure = failed?.read === read ? failed : undefined;
  const pending = useRef<AbortController | null>(null);
  const request = useRef({ start: "0", history: [] as string[] });
  const { hostId, kind, id, revision } = receiptsRef;
  const reference = useMemo(
    () => ({
      hostId,
      kind,
      id,
      ...(revision === undefined ? {} : { revision }),
    }),
    [hostId, kind, id, revision],
  );
  useEffect(() => {
    setSnapshot(undefined);
    setFailed(undefined);
    setBusy(false);
    request.current = { start: "0", history: [] };
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [reference, read]);
  async function load(start: string, history: string[]) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailed(undefined);
    setSnapshot(undefined);
    request.current = { start, history };
    try {
      const result = await read(
        {
          receiptsRef: reference,
          startOrdinal: start,
          maxReceipts: "32",
          maxBytes: "65536",
        },
        controller.signal,
      );
      if (!controller.signal.aborted)
        setSnapshot({ read, result, start, history });
    } catch (reason: unknown) {
      if (!controller.signal.aborted)
        setFailed({
          read,
          code: nativeErrorCode(reason),
          eventKey: operationFailureEventKey(reason),
        });
    } finally {
      if (pending.current === controller) pending.current = null;
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
          onClick={() =>
            void load(
              failure ? request.current.start : "0",
              failure ? request.current.history : [],
            )
          }
        >
          {failure ? labels.retry : labels.receipt}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !page?.history.length}
          onClick={() =>
            page && void load(page.history.at(-1)!, page.history.slice(0, -1))
          }
        >
          {labels.previousPage}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !page?.result.hasMore}
          onClick={() =>
            page &&
            void load(page.result.nextOrdinal, [...page.history, page.start])
          }
        >
          {labels.nextPage}
        </Button>
      </div>
      <WorkbenchNotice
        noticeKey={`receipts:${failure?.code ?? "unknown"}`}
        eventKey={failure?.eventKey}
        log={
          failure
            ? {
                module: "transfer",
                level: "error",
                code: failure.code,
                context: labels.receipt,
                message: labels.operationText.failure(failure.code),
              }
            : undefined
        }
      >
        {failure ? (
          <span role="alert">{labels.operationText.failure(failure.code)}</span>
        ) : null}
      </WorkbenchNotice>
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
                {labels[receipt.outcome]} [{receipt.byteStart},{" "}
                {receipt.byteEnd})
              </span>
              <Popover>
                <PopoverTrigger asChild>
                  <WorkbenchIconButton label={labels.operationText.details}>
                    <Info aria-hidden="true" />
                  </WorkbenchIconButton>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="workbench-detail-popover"
                >
                  <Textarea
                    aria-label={labels.operationText.details}
                    readOnly
                    value={JSON.stringify(
                      {
                        sourceOffset,
                        receipt: {
                          ...receipt,
                          backendError: receipt.backendError
                            ? {
                                code: nativeErrorCode(receipt.backendError),
                                retryable: receipt.backendError.retryable,
                              }
                            : undefined,
                        },
                      },
                      null,
                      2,
                    )}
                    onFocus={(event) => event.currentTarget.select()}
                    className="workbench-log-details"
                  />
                </PopoverContent>
              </Popover>
              {receipt.unknownRanges.map((range) => (
                <p key={range.start}>
                  {labels.unknownBytes}: [{range.start}, {range.end})
                </p>
              ))}
              {receipt.backendError && (
                <p>
                  {labels.operationText.failure(
                    nativeErrorCode(receipt.backendError),
                  )}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
