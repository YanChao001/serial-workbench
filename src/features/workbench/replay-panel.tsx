import type {
  CaptureRecord,
  Operation,
  ReplayControlParams,
  ReplayReadParams,
  ReplayReadResult,
  ReplayRecord,
  SessionSnapshot,
  TerminalSettings,
} from "@serial-workbench/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, CornerDownRight, Info, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { nativeErrorCode } from "@/lib/native-error";
import { parseU64 } from "@/lib/u64";
import { captureRecordItems } from "./capture-record-items";
import { StreamView } from "./stream-view";
import { WorkbenchIconButton } from "./workbench-icon-button";
import { WorkbenchNotice, operationFailureEventKey } from "./workbench-notice";
import { workbenchStatus } from "./stream-presentation";
import { TxReceiptFacts } from "./tx-receipt-facts";
import type { WorkbenchLabels } from "./labels";
import type { StreamPresentationLabels } from "./stream-presentation";
export type ReplayReader = (
  params: ReplayReadParams,
  signal?: AbortSignal,
) => Promise<ReplayReadResult>;
export type ReplayRecordReader = (
  record: Extract<ReplayRecord, { kind: "reference" }>,
  signal?: AbortSignal,
) => Promise<CaptureRecord>;
export type ReplayController = (
  params: ReplayControlParams,
  signal?: AbortSignal,
) => Promise<Operation>;
export type ReplayPanelProps = {
  session: SessionSnapshot;
  read: ReplayReader;
  readRecord: ReplayRecordReader;
  control: ReplayController;
  disabled: boolean;
  labels: WorkbenchLabels;
  terminalSettings?: TerminalSettings;
  presentationLabels?: StreamPresentationLabels;
};
export function ReplayPanel({
  session,
  read,
  readRecord,
  control,
  disabled,
  labels,
  terminalSettings,
  presentationLabels,
}: ReplayPanelProps) {
  const [page, setPage] = useState<ReplayReadResult>();
  const [expanded, setExpanded] = useState<Record<string, CaptureRecord>>({});
  const [seek, setSeek] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; eventKey: string }>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const noticeId = useId();
  const attempts = useRef(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false);
    setPage(undefined);
    setExpanded({});
    setError(undefined);
    setDetailsOpen(false);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [read, readRecord, session.sessionId, session.sessionEpoch]);
  async function act(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    const attempt = ++attempts.current;
    setBusy(true);
    setError(undefined);
    try {
      await action(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError({
          code: nativeErrorCode(reason) ?? "INTERNAL",
          eventKey:
            operationFailureEventKey(reason) ?? `${noticeId}:replay:${attempt}`,
        });
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const records =
    page?.records.flatMap((record) =>
      record.kind === "inline"
        ? [record.record]
        : expanded[record.recordOrdinal]
          ? [expanded[record.recordOrdinal]!]
          : [],
    ) ?? [];
  const items = captureRecordItems(records);
  const sendControl = (paused: boolean, seekRecord?: string) =>
    act(async (signal) => {
      await control(
        {
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          paused,
          ...(seekRecord !== undefined ? { seekRecord } : {}),
        },
        signal,
      );
      if (!signal.aborted && seekRecord !== undefined) {
        setPage(undefined);
        setExpanded({});
      }
    });
  const validSeek = parseU64(seek) !== undefined;
  return (
    <section aria-label={labels.replay} className="workbench-replay">
      <div className="workbench-toolbar workbench-replay-toolbar">
        <h2 className="sr-only">{labels.replay}</h2>
        <WorkbenchIconButton
          label={labels.readReplay}
          disabled={busy}
          onClick={() =>
            void act(async (signal) => {
              const result = await read(
                {
                  sessionId: session.sessionId,
                  sessionEpoch: session.sessionEpoch,
                  maxRecords: "100",
                  maxBytes: "65536",
                },
                signal,
              );
              if (!signal.aborted) {
                setPage(result);
                setExpanded({});
              }
            })
          }
        >
          <BookOpen aria-hidden="true" />
        </WorkbenchIconButton>
        <WorkbenchIconButton
          label={labels.pauseReplay}
          disabled={disabled || busy}
          onClick={() => void sendControl(true)}
        >
          <Pause aria-hidden="true" />
        </WorkbenchIconButton>
        <WorkbenchIconButton
          label={labels.resumeReplay}
          disabled={disabled || busy}
          onClick={() => void sendControl(false)}
        >
          <Play aria-hidden="true" />
        </WorkbenchIconButton>
        <Input
          aria-label={labels.seekRecord}
          value={seek}
          onChange={(event) => setSeek(event.target.value)}
          inputMode="numeric"
          className="workbench-replay-seek"
        />
        <WorkbenchIconButton
          label={labels.seekRecord}
          disabled={disabled || busy || !validSeek}
          onClick={() => void sendControl(true, seek)}
        >
          <CornerDownRight aria-hidden="true" />
        </WorkbenchIconButton>
        <span role="status" className="workbench-replay-status">
          {page?.atEnd ? labels.atEnd : ""}
        </span>
        <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
          <PopoverTrigger asChild>
            <WorkbenchIconButton
              label={labels.operationText.details}
              disabled={!page && !error}
            >
              <Info aria-hidden="true" />
            </WorkbenchIconButton>
          </PopoverTrigger>
          <PopoverContent
            aria-label={labels.operationText.details}
            align="end"
            className="workbench-detail-popover workbench-replay-details"
          >
            {error && <p>{labels.operationText.failure(error.code)}</p>}
            {page?.records.map(
              (record) =>
                record.kind === "reference" && (
                  <section key={record.recordOrdinal}>
                    <h3>
                      {labels.captureLargeRecord} {record.recordOrdinal}
                    </h3>
                    {!expanded[record.recordOrdinal] && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void act(async (signal) => {
                            const result = await readRecord(record, signal);
                            if (!signal.aborted)
                              setExpanded((current) => ({
                                ...current,
                                [record.recordOrdinal]: result,
                              }));
                          })
                        }
                      >
                        {labels.readReplay} {record.recordOrdinal}
                      </Button>
                    )}
                    <Textarea
                      readOnly
                      aria-label={labels.captureLargeRecord}
                      value={JSON.stringify(record, null, 2)}
                      className="workbench-log-details"
                    />
                  </section>
                ),
            )}
            {records.map(
              (record) =>
                record.entry.kind === "tx_settlement" && (
                  <section key={record.recordOrdinal}>
                    <h3>
                      {labels.receipt} {record.recordOrdinal}
                    </h3>
                    <p>
                      {workbenchStatus(
                        record.entry.value.receipt.outcome,
                        labels,
                      )}
                    </p>
                    <TxReceiptFacts
                      receipt={record.entry.value.receipt}
                      labels={labels}
                    />
                    <Textarea
                      readOnly
                      aria-label={labels.receipt}
                      className="workbench-log-details"
                      value={JSON.stringify(
                        {
                          recordOrdinal: record.recordOrdinal,
                          hostId: record.entry.value.hostId,
                          instanceEpoch: record.entry.value.instanceEpoch,
                          operationId: record.entry.value.receipt.operationId,
                          sessionId: record.entry.value.receipt.sessionId,
                          sessionEpoch: record.entry.value.receipt.sessionEpoch,
                          outcome: record.entry.value.receipt.outcome,
                          backendErrorCode:
                            record.entry.value.receipt.backendError?.code,
                        },
                        null,
                        2,
                      )}
                    />
                  </section>
                ),
            )}
          </PopoverContent>
        </Popover>
      </div>
      <WorkbenchNotice
        noticeKey={`replay:${error?.code ?? "none"}`}
        eventKey={error?.eventKey}
        log={
          error
            ? {
                module: "capture",
                level: "error",
                code: error.code,
                message: labels.operationText.failure(error.code),
                context: labels.replay,
              }
            : undefined
        }
      >
        {error ? (
          <span role="alert">{labels.operationText.failure(error.code)}</span>
        ) : null}
      </WorkbenchNotice>
      <StreamView
        key={page?.readerGeneration ?? "unread"}
        items={items}
        labels={labels}
        terminalSettings={terminalSettings}
        presentationLabels={presentationLabels}
      />
    </section>
  );
}
